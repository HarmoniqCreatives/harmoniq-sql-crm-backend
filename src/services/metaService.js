const { v4: uuidv4 } = require('uuid')
const { Op } = require('sequelize')
const { security } = require('../config/security')
const { getModels } = require('../models')
const {
  metaConnectionStatuses,
  metaModes,
  metaPageStatuses,
  metaSyncJobStatuses,
  permissionKeys,
  userStatuses,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const {
  createSecretToken,
  hashSecret,
  isWithinLength,
  readText,
} = require('../utils/helpers')
const { messages } = require('../utils/messages')
const { decryptSecret, encryptSecret } = require('../utils/metaSecrets')
const graphClient = require('./metaGraph')
const {
  enqueueInitialPageSync,
  getLatestSyncJobForPage,
  listLeadCounts,
  presentSyncJob,
} = require('./metaLeadService')

function presentProfile(profile) {
  let appId = profile.appId || ''
  if (profile.mode === metaModes.central) {
    appId = process.env.META_APP_ID || ''
  }
  return {
    id: profile.id,
    mode: profile.mode,
    label: profile.label,
    appId,
    secretStored: Boolean(profile.secretStored),
    isActive: Boolean(profile.isActive),
    createdAt: profile.createdAt,
  }
}

function presentConnection(connection) {
  return {
    id: connection.id,
    appProfileId: connection.appProfileId,
    metaUserId: connection.metaUserId,
    displayName: connection.displayName,
    connectionLabel: connection.connectionLabel || '',
    status: connection.status,
    tokenExpiresAt: connection.tokenExpiresAt || null,
    lastVerifiedAt: connection.lastVerifiedAt || null,
    grantedPermissions: Array.isArray(connection.grantedPermissions) ? connection.grantedPermissions : [],
    declinedPermissions: Array.isArray(connection.declinedPermissions) ? connection.declinedPermissions : [],
    missingPermissions: Array.isArray(connection.missingPermissions) ? connection.missingPermissions : [],
    pageFetchErrors: Array.isArray(connection.pageFetchErrors) ? connection.pageFetchErrors : [],
    createdAt: connection.createdAt,
  }
}

function presentPage(page, latestSyncJob = null, leadCounts = null) {
  return {
    id: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    name: page.name,
    status: page.status,
    webhookSubscribed: Boolean(page.webhookSubscribed),
    subscriptionError: page.subscriptionError || '',
    lastFetchedAt: page.lastFetchedAt || null,
    lastSyncAt: page.lastSyncAt || null,
    lastError: page.lastError || '',
    createdAt: page.createdAt,
    latestSyncJob: latestSyncJob || null,
    counts: {
      imported: leadCounts?.imported || 0,
      skipped: leadCounts?.skipped || 0,
    },
  }
}

function readRequiredPermissionList() {
  return String(messages.metaRequiredPermissions)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function missingFromGranted(granted) {
  const grantedSet = new Set(granted || [])
  return readRequiredPermissionList().filter((name) => !grantedSet.has(name))
}

function readFrontendBaseUrl() {
  const base = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '')
  if (!base) {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(errors.appBaseUrlMissing, 500)
    }
    return String(process.env.FRONTEND_URL || 'http://localhost:5174').replace(/\/$/, '')
  }
  if (process.env.NODE_ENV === 'production') {
    if (!base.startsWith('https://') || /localhost|127\.0\.0\.1/i.test(base)) {
      throw new AppError(errors.appBaseUrlInvalid, 500)
    }
  }
  return base
}

function buildOAuthRedirect(result) {
  const url = new URL(`${readFrontendBaseUrl()}/meta`)
  url.searchParams.set(messages.metaResultParam, result)
  return url.toString()
}

async function findProfile(auth, profileId) {
  const { MetaAppProfile } = getModels()
  if (!profileId) {
    throw new AppError(errors.metaProfileNotFound, 404)
  }
  const profile = await MetaAppProfile.findOne({
    where: { id: profileId, companyId: auth.companyId },
  })
  if (!profile) {
    throw new AppError(errors.metaProfileNotFound, 404)
  }
  return profile
}

async function findConnection(auth, connectionId) {
  const { MetaConnection } = getModels()
  if (!connectionId) {
    throw new AppError(errors.metaConnectionNotFound, 404)
  }
  const connection = await MetaConnection.findOne({
    where: { id: connectionId, companyId: auth.companyId },
  })
  if (!connection) {
    throw new AppError(errors.metaConnectionNotFound, 404)
  }
  return connection
}

async function findPage(auth, pageRowId) {
  const { MetaPage } = getModels()
  if (!pageRowId) {
    throw new AppError(errors.metaPageNotFound, 404)
  }
  const page = await MetaPage.findOne({
    where: { id: pageRowId, companyId: auth.companyId },
  })
  if (!page) {
    throw new AppError(errors.metaPageNotFound, 404)
  }
  return page
}

function readPublicAppId(profile) {
  if (profile.mode === metaModes.central) {
    const appId = process.env.META_APP_ID
    if (!appId) throw new AppError(errors.metaAppMissing, 500)
    return appId
  }
  if (!profile.appId) throw new AppError(errors.metaAppRequired, 400)
  return profile.appId
}

async function readAppCredentials(profile) {
  if (profile.mode === metaModes.central) {
    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) throw new AppError(errors.metaAppMissing, 500)
    return { appId, appSecret }
  }
  if (!profile.appId || !profile.appSecretCipher) {
    throw new AppError(errors.metaAppRequired, 400)
  }
  return {
    appId: profile.appId,
    appSecret: decryptSecret(profile.appSecretCipher),
  }
}

/**
 * Lists Meta app profiles for the signed-in company.
 */
async function listProfiles(auth) {
  const { MetaAppProfile } = getModels()
  const rows = await MetaAppProfile.findAll({
    where: { companyId: auth.companyId },
    order: [['createdAt', 'ASC']],
  })
  return rows.map(presentProfile)
}

/**
 * Creates a Meta app profile (central uses env secrets; customer stores encrypted secret).
 */
async function createProfile(auth, body) {
  const { MetaAppProfile } = getModels()
  const label = readText(body, 'label')
  if (!label || !isWithinLength(label, security.metaLabelMaxLength)) {
    throw new AppError(errors.metaProfileLabelRequired, 400)
  }
  const mode = readText(body, 'mode') || metaModes.customer
  if (!Object.values(metaModes).includes(mode)) {
    throw new AppError(errors.requestFailed, 400)
  }
  const fields = {
    id: uuidv4(),
    companyId: auth.companyId,
    mode,
    label,
    appId: '',
    secretStored: false,
    isActive: true,
    createdBy: auth.userId,
    updatedBy: auth.userId,
  }
  if (mode === metaModes.customer) {
    const appId = readText(body, 'appId')
    const appSecret = readText(body, 'appSecret')
    if (!appId || !appSecret) throw new AppError(errors.metaAppRequired, 400)
    if (!isWithinLength(appSecret, security.metaSecretMaxLength)) {
      throw new AppError(errors.valueTooLong, 400)
    }
    fields.appId = appId
    fields.appSecretCipher = encryptSecret(appSecret)
    fields.secretStored = true
  }
  try {
    const profile = await MetaAppProfile.create(fields)
    return presentProfile(profile)
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(errors.metaProfileLabelTaken, 409)
    }
    throw error
  }
}

async function updateProfile(auth, profileId, body) {
  const profile = await findProfile(auth, profileId)
  const label = readText(body, 'label')
  if (label) {
    if (!isWithinLength(label, security.metaLabelMaxLength)) {
      throw new AppError(errors.metaProfileLabelRequired, 400)
    }
    profile.label = label
  }
  if (profile.mode === metaModes.customer) {
    const appId = readText(body, 'appId')
    if (appId) profile.appId = appId
    const appSecret = readText(body, 'appSecret')
    if (appSecret) {
      if (!isWithinLength(appSecret, security.metaSecretMaxLength)) {
        throw new AppError(errors.valueTooLong, 400)
      }
      profile.appSecretCipher = encryptSecret(appSecret)
      profile.secretStored = true
    }
  }
  profile.updatedBy = auth.userId
  try {
    await profile.save()
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(errors.metaProfileLabelTaken, 409)
    }
    throw error
  }
  return presentProfile(profile)
}

async function removeProfile(auth, profileId) {
  const profile = await findProfile(auth, profileId)
  await profile.destroy()
}

async function listConnections(auth) {
  const { MetaConnection } = getModels()
  const rows = await MetaConnection.findAll({
    where: { companyId: auth.companyId },
    order: [['createdAt', 'DESC']],
  })
  return rows.map(presentConnection)
}

/**
 * Starts Facebook Login. State is stored hashed, single-use, 10 minutes.
 */
async function startOAuth(auth, body) {
  const { MetaOAuthState } = getModels()
  const profile = await findProfile(auth, readText(body, 'profileId'))
  const redirectUri = process.env.META_REDIRECT_URI
  if (!redirectUri) throw new AppError(errors.metaRedirectMissing, 500)

  const state = createSecretToken()
  const expiresAt = new Date(Date.now() + security.oauthStateMinutes * 60 * 1000)
  const stateFields = {
    id: uuidv4(),
    stateHash: hashSecret(state),
    companyId: auth.companyId,
    userId: auth.userId,
    appProfileId: profile.id,
    expiresAt,
    usedAt: null,
    connectionLabel: '',
    rerequest: false,
  }

  const requestedConnection = readText(body, 'connectionId')
  if (requestedConnection) {
    const connection = await findConnection(auth, requestedConnection)
    if (connection.appProfileId !== profile.id) {
      throw new AppError(errors.metaConnectionNotFound, 404)
    }
    stateFields.connectionId = connection.id
    const missing = Array.isArray(connection.missingPermissions) ? connection.missingPermissions : []
    const declined = Array.isArray(connection.declinedPermissions) ? connection.declinedPermissions : []
    if (missing.length > 0 || declined.length > 0 || readText(body, 'authType') === 'rerequest') {
      stateFields.rerequest = true
    }
  }
  if (readText(body, 'authType') === 'rerequest') {
    stateFields.rerequest = true
  }
  const connectionLabel = readText(body, 'connectionLabel')
  if (connectionLabel) {
    stateFields.connectionLabel = connectionLabel.slice(0, security.metaLabelMaxLength)
  }

  await MetaOAuthState.create(stateFields)

  const url = new URL(`https://www.facebook.com/${graphClient.readGraphVersion()}/dialog/oauth`)
  url.searchParams.set('client_id', readPublicAppId(profile))
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', messages.metaOAuthScope)
  url.searchParams.set('response_type', 'code')
  if (stateFields.rerequest) {
    url.searchParams.set('auth_type', 'rerequest')
  }
  return url.toString()
}

/**
 * Consumes a single-use OAuth state. Returns null for missing/reused/expired.
 */
async function consumeState(rawState) {
  if (!rawState) return null
  const { MetaOAuthState, sequelize } = getModels()
  return sequelize.transaction(async (transaction) => {
    const row = await MetaOAuthState.findOne({
      where: {
        stateHash: hashSecret(rawState),
        usedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
    if (!row) return null
    row.usedAt = new Date()
    await row.save({ transaction })
    return row
  })
}

async function assertCallbackUser(state) {
  const { User, Role, Company } = getModels()
  const user = await User.findByPk(state.userId)
  if (!user || user.companyId !== state.companyId) {
    throw new AppError(errors.metaOAuthFailed, 400)
  }
  if (user.status !== userStatuses.active || !user.emailVerified) {
    throw new AppError(errors.metaOAuthFailed, 400)
  }
  const company = await Company.findByPk(state.companyId)
  if (!company) throw new AppError(errors.metaOAuthFailed, 400)
  const role = await Role.findByPk(user.roleId)
  if (!role || role.companyId !== state.companyId) {
    throw new AppError(errors.metaOAuthFailed, 400)
  }
  const permissions = role.permissions || []
  if (!permissions.includes(permissionKeys.metaManage)) {
    throw new AppError(errors.metaOAuthFailed, 400)
  }
  return user
}

async function saveConnection(state, profile, facebookUser, token, expiresIn, permissionInfo) {
  const { MetaConnection } = getModels()
  let tokenExpiresAt = null
  if (typeof expiresIn === 'number') {
    tokenExpiresAt = new Date(Date.now() + expiresIn * 1000)
  }
  const grantedPermissions = Array.isArray(permissionInfo?.granted) ? permissionInfo.granted : []
  const declinedPermissions = Array.isArray(permissionInfo?.declined) ? permissionInfo.declined : []
  const missingPermissions = missingFromGranted(grantedPermissions)
  const cipher = encryptSecret(token)
  const metaUserId = String(facebookUser.id)

  let connection = null
  if (state.connectionId) {
    connection = await MetaConnection.findOne({
      where: { id: state.connectionId, appProfileId: profile.id, companyId: state.companyId },
    })
    if (!connection) throw new AppError(errors.metaConnectionNotFound, 404)
    if (String(connection.metaUserId) !== metaUserId) {
      throw new AppError(errors.metaAccountMismatch, 400)
    }
  }
  if (!connection) {
    connection = await MetaConnection.findOne({
      where: { appProfileId: profile.id, metaUserId, companyId: state.companyId },
    })
  }

  const connectionLabel = state.connectionLabel ? String(state.connectionLabel).trim() : ''
  // Keep a previously valid user token when reconnect declines lead/ad scopes (legacy parity).
  let replaceToken = true
  if (connection && connection.tokenCipher) {
    if (missingPermissions.includes('leads_retrieval') || missingPermissions.includes('ads_read')) {
      replaceToken = false
    }
  }

  if (!connection) {
    connection = await MetaConnection.create({
      id: uuidv4(),
      companyId: state.companyId,
      appProfileId: profile.id,
      metaUserId,
      displayName: facebookUser.name || '',
      connectionLabel,
      tokenCipher: cipher,
      tokenExpiresAt,
      status: metaConnectionStatuses.connected,
      connectedBy: state.userId,
      grantedPermissions,
      declinedPermissions,
      missingPermissions,
      pageFetchErrors: replaceToken ? [] : [errors.metaPermissionsIncomplete],
      lastVerifiedAt: new Date(),
      disconnectedAt: null,
    })
    return connection
  }

  connection.displayName = facebookUser.name || connection.displayName
  if (replaceToken) {
    connection.tokenCipher = cipher
    connection.tokenExpiresAt = tokenExpiresAt
  }
  connection.status = metaConnectionStatuses.connected
  connection.connectedBy = state.userId
  connection.disconnectedAt = null
  connection.grantedPermissions = grantedPermissions
  connection.declinedPermissions = declinedPermissions
  connection.missingPermissions = missingPermissions
  connection.lastVerifiedAt = new Date()
  if (connectionLabel) connection.connectionLabel = connectionLabel
  if (!replaceToken) {
    const errorsList = Array.isArray(connection.pageFetchErrors) ? [...connection.pageFetchErrors] : []
    if (!errorsList.includes(errors.metaPermissionsIncomplete)) {
      errorsList.push(errors.metaPermissionsIncomplete)
    }
    connection.pageFetchErrors = errorsList
  }
  await connection.save()
  return connection
}

/**
 * Stores Pages returned by Graph for a connection (encrypted page tokens). Does not subscribe.
 */
async function upsertListedPages(connection, graphPages) {
  const { MetaPage } = getModels()
  const pageFetchErrors = []
  for (const page of graphPages) {
    if (!page.id || !page.access_token) continue
    const existing = await MetaPage.findOne({
      where: { companyId: connection.companyId, pageId: String(page.id) },
    })
    if (existing && existing.connectionId !== connection.id && existing.status === metaPageStatuses.connected) {
      pageFetchErrors.push(`Page ${page.id} already connected`)
      continue
    }
    if (existing) {
      // Refresh catalog only for this connection's disconnected rows; never overwrite another connection's connected page.
      if (existing.connectionId === connection.id) {
        existing.name = page.name || existing.name
        existing.tokenCipher = encryptSecret(page.access_token)
        existing.metaUserId = connection.metaUserId
        existing.appProfileId = connection.appProfileId
        existing.lastFetchedAt = new Date()
        await existing.save()
      }
      continue
    }
    await MetaPage.create({
      id: uuidv4(),
      companyId: connection.companyId,
      connectionId: connection.id,
      appProfileId: connection.appProfileId,
      metaUserId: connection.metaUserId,
      pageId: String(page.id),
      name: page.name || String(page.id),
      tokenCipher: encryptSecret(page.access_token),
      status: metaPageStatuses.disconnected,
      webhookSubscribed: false,
      subscriptionError: '',
      lastFetchedAt: new Date(),
      lastError: '',
    })
  }
  return pageFetchErrors
}

async function handleOAuthCallback(query) {
  const rawState = typeof query.state === 'string' ? query.state : ''
  const code = typeof query.code === 'string' ? query.code : ''
  if (!rawState || !code) {
    return buildOAuthRedirect(messages.metaResultError)
  }

  const state = await consumeState(rawState)
  if (!state) {
    return buildOAuthRedirect(messages.metaResultError)
  }

  try {
    await assertCallbackUser(state)
    const { MetaAppProfile } = getModels()
    const profile = await MetaAppProfile.findOne({
      where: { id: state.appProfileId, companyId: state.companyId },
    })
    if (!profile) return buildOAuthRedirect(messages.metaResultError)

    const credentials = await readAppCredentials(profile)
    const redirectUri = process.env.META_REDIRECT_URI
    if (!redirectUri) return buildOAuthRedirect(messages.metaResultError)

    const shortLived = await graphClient.exchangeAuthorizationCode({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      redirectUri,
      code,
    })
    const longLived = await graphClient.exchangeLongLivedToken({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      accessToken: shortLived.accessToken,
    })
    const facebookUser = await graphClient.readFacebookUser(longLived.accessToken)
    const permissionInfo = await graphClient.readGrantedPermissions(longLived.accessToken)
    const connection = await saveConnection(
      state,
      profile,
      facebookUser,
      longLived.accessToken,
      longLived.expiresIn,
      permissionInfo,
    )

    try {
      const pages = await graphClient.readFacebookPages(longLived.accessToken)
      const pageErrors = await upsertListedPages(connection, pages)
      if (pageErrors.length) {
        connection.pageFetchErrors = pageErrors
        await connection.save()
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'META_TOKEN_EXPIRED') {
        connection.status = metaConnectionStatuses.expired
        await connection.save()
      } else if (error instanceof AppError && error.code === 'META_PERMISSION_MISSING') {
        const missing = missingFromGranted(permissionInfo.granted)
        connection.missingPermissions = missing
        connection.pageFetchErrors = [errors.metaPermissionMissing]
        await connection.save()
        return buildOAuthRedirect(messages.metaResultError)
      } else {
        connection.pageFetchErrors = [errors.metaExchangeFailed]
        await connection.save()
      }
    }

    const missing = missingFromGranted(permissionInfo.granted)
    if (missing.length > 0) {
      // Honest status: connection saved with declined scopes; UI can rerequest.
      return buildOAuthRedirect(messages.metaResultOk)
    }
    return buildOAuthRedirect(messages.metaResultOk)
  } catch (error) {
    if (error instanceof AppError && error.code === 'META_TOKEN_EXPIRED') {
      // Connection may not exist yet.
    }
    return buildOAuthRedirect(messages.metaResultError)
  }
}

async function listAvailablePages(auth, connectionId) {
  const connection = await findConnection(auth, connectionId)
  if (connection.status !== metaConnectionStatuses.connected || !connection.tokenCipher) {
    throw new AppError(errors.metaTokenExpired, 400, 'META_TOKEN_EXPIRED', { action: 'RECONNECT' })
  }
  const { MetaPage } = getModels()
  let token
  try {
    token = decryptSecret(connection.tokenCipher)
  } catch {
    throw new AppError(errors.metaTokenExpired, 400, 'META_TOKEN_EXPIRED', { action: 'RECONNECT' })
  }

  let graphPages
  try {
    graphPages = await graphClient.readFacebookPages(token)
  } catch (error) {
    if (error instanceof AppError && error.code === 'META_TOKEN_EXPIRED') {
      connection.status = metaConnectionStatuses.expired
      await connection.save()
    }
    throw error
  }

  const connected = await MetaPage.findAll({
    where: {
      companyId: auth.companyId,
      status: metaPageStatuses.connected,
    },
    attributes: ['pageId'],
  })
  const connectedIds = new Set(connected.map((row) => row.pageId))
  return graphPages
    .filter((page) => !connectedIds.has(String(page.id)))
    .map((page) => ({
      pageId: String(page.id),
      name: page.name || String(page.id),
    }))
}

/**
 * Connects selected Pages after re-fetching eligible Pages from Meta (never trusts client IDs alone).
 * Subscribes leadgen; does NOT import leads.
 */
async function connectSelectedPages(auth, connectionId, body) {
  const connection = await findConnection(auth, connectionId)
  if (connection.status !== metaConnectionStatuses.connected || !connection.tokenCipher) {
    throw new AppError(errors.metaTokenExpired, 400, 'META_TOKEN_EXPIRED', { action: 'RECONNECT' })
  }
  const requested = Array.isArray(body?.pageIds)
    ? body.pageIds.map((id) => String(id)).filter(Boolean)
    : []
  if (requested.length === 0) {
    throw new AppError(errors.metaPageUnauthorized, 400)
  }

  let userToken
  try {
    userToken = decryptSecret(connection.tokenCipher)
  } catch {
    throw new AppError(errors.metaTokenExpired, 400, 'META_TOKEN_EXPIRED', { action: 'RECONNECT' })
  }

  let graphPages
  try {
    graphPages = await graphClient.readFacebookPages(userToken)
  } catch (error) {
    if (error instanceof AppError && error.code === 'META_TOKEN_EXPIRED') {
      connection.status = metaConnectionStatuses.expired
      await connection.save()
    }
    throw error
  }

  const eligible = new Map(graphPages.map((page) => [String(page.id), page]))
  const { MetaPage, sequelize } = getModels()
  const results = []

  for (const pageId of requested) {
    const graphPage = eligible.get(pageId)
    if (!graphPage || !graphPage.access_token) {
      results.push({ pageId, status: 'failed', reason: errors.metaPageUnauthorized })
      continue
    }

    try {
      const outcome = await sequelize.transaction(async (transaction) => {
        let page = await MetaPage.findOne({
          where: { companyId: auth.companyId, pageId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
        if (page && page.status === metaPageStatuses.connected) {
          return { pageId, status: 'skipped', reason: errors.metaPageAlreadyConnected }
        }
        if (!page) {
          page = await MetaPage.create({
            id: uuidv4(),
            companyId: auth.companyId,
            connectionId: connection.id,
            appProfileId: connection.appProfileId,
            metaUserId: connection.metaUserId,
            pageId,
            name: graphPage.name || pageId,
            tokenCipher: encryptSecret(graphPage.access_token),
            status: metaPageStatuses.connected,
            webhookSubscribed: false,
            subscriptionError: '',
            lastFetchedAt: new Date(),
            lastError: '',
          }, { transaction })
        } else {
          page.connectionId = connection.id
          page.appProfileId = connection.appProfileId
          page.metaUserId = connection.metaUserId
          page.name = graphPage.name || page.name
          page.tokenCipher = encryptSecret(graphPage.access_token)
          page.status = metaPageStatuses.connected
          page.lastFetchedAt = new Date()
          page.lastError = ''
          await page.save({ transaction })
        }

        let webhookSubscribed = false
        let subscriptionError = ''
        try {
          await graphClient.subscribePageLeadgen(graphPage.access_token, pageId)
          webhookSubscribed = true
        } catch (error) {
          webhookSubscribed = false
          if (error instanceof AppError) {
            subscriptionError = error.message
            if (error.code === 'META_TOKEN_EXPIRED') {
              page.status = metaPageStatuses.expired
            }
          } else {
            subscriptionError = errors.metaSubscribeFailed
          }
        }
        page.webhookSubscribed = webhookSubscribed
        page.subscriptionError = subscriptionError
        page.lastError = subscriptionError
        await page.save({ transaction })

        return {
          pageId,
          metaPageId: page.id,
          status: webhookSubscribed ? 'added' : 'failed',
          reason: webhookSubscribed ? '' : subscriptionError || errors.metaSubscribeFailed,
          page,
        }
      })

      // Initial sync only after Page is saved + leadgen subscribed (reuse Phase 2 job).
      if (outcome.status === 'added' && outcome.page) {
        const sync = await enqueueInitialPageSync(auth, outcome.page.id)
        if (sync.syncEnqueueError) {
          outcome.page.lastError = sync.syncEnqueueError
          await outcome.page.save()
        }
        const latestSyncJob = sync.syncJob || await getLatestSyncJobForPage(auth.companyId, outcome.page.id)
        results.push({
          pageId: outcome.pageId,
          status: 'added',
          reason: '',
          initialSyncStarted: Boolean(sync.syncJob),
          syncEnqueueError: sync.syncEnqueueError || '',
          message: sync.syncJob
            ? messages.metaInitialSyncStarted
            : messages.metaInitialSyncEnqueueFailed,
          syncJob: sync.syncJob,
          page: presentPage(outcome.page, latestSyncJob),
        })
        continue
      }

      if (outcome.page) {
        results.push({
          pageId: outcome.pageId,
          status: outcome.status,
          reason: outcome.reason || '',
          initialSyncStarted: false,
          syncJob: null,
          page: presentPage(outcome.page),
        })
      } else {
        results.push(outcome)
      }
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        results.push({ pageId, status: 'skipped', reason: errors.metaPageAlreadyConnected })
        continue
      }
      results.push({
        pageId,
        status: 'failed',
        reason: error instanceof AppError ? error.message : errors.metaExchangeFailed,
      })
    }
  }

  return { results }
}

async function listPages(auth, query) {
  const { MetaPage } = getModels()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(
    security.metaPageMaxLimit,
    Math.max(1, Number(query.limit) || security.metaPageDefaultLimit),
  )
  const where = { companyId: auth.companyId }
  if (query.status) {
    where.status = String(query.status)
  } else {
    where.status = metaPageStatuses.connected
  }
  if (query.connectionId) {
    where.connectionId = String(query.connectionId)
  }
  const { rows, count } = await MetaPage.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  })
  const latestByPage = new Map()
  if (rows.length > 0) {
    const { MetaSyncJob } = getModels()
    const jobs = await MetaSyncJob.findAll({
      where: {
        companyId: auth.companyId,
        metaPageId: { [Op.in]: rows.map((row) => row.id) },
      },
      order: [['createdAt', 'DESC']],
    })
    const inFlightByPage = new Map()
    for (const job of jobs) {
      if (!latestByPage.has(job.metaPageId)) {
        latestByPage.set(job.metaPageId, job)
      }
      if (
        (job.status === metaSyncJobStatuses.pending
          || job.status === metaSyncJobStatuses.processing)
        && !inFlightByPage.has(job.metaPageId)
      ) {
        inFlightByPage.set(job.metaPageId, job)
      }
    }
    for (const [metaPageId, job] of inFlightByPage) {
      latestByPage.set(metaPageId, job)
    }
  }
  const leadCounts = await listLeadCounts(auth)
  return {
    pages: rows.map((row) => {
      const job = latestByPage.get(row.id)
      const pageCounts = leadCounts.pages[row.pageId] || { imported: 0, skipped: 0 }
      return presentPage(row, job ? presentSyncJob(job) : null, pageCounts)
    }),
    pagination: { page, limit, total: count },
    leadCounts: {
      imported: leadCounts.imported,
      skipped: leadCounts.skipped,
      pages: Object.fromEntries(
        Object.entries(leadCounts.pages).map(([facebookPageId, value]) => [
          facebookPageId,
          { imported: value.imported || 0, skipped: value.skipped || 0 },
        ]),
      ),
    },
  }
}

/**
 * Disconnects a Page idempotently. Best-effort Meta unsubscribe; local state always updates.
 */
async function disconnectPage(auth, pageRowId) {
  const page = await findPage(auth, pageRowId)
  if (page.status === metaPageStatuses.disconnected) {
    return presentPage(page)
  }

  if (page.tokenCipher) {
    try {
      const token = decryptSecret(page.tokenCipher)
      await graphClient.unsubscribePageLeadgen(token, page.pageId)
    } catch (error) {
      console.error(JSON.stringify({
        event: 'meta_unsubscribe_failed',
        pageId: page.pageId,
        companyId: page.companyId,
        message: error instanceof AppError ? error.message : 'unsubscribe_failed',
      }))
    }
  }

  page.status = metaPageStatuses.disconnected
  page.webhookSubscribed = false
  page.subscriptionError = ''
  await page.save()
  return presentPage(page)
}

async function disconnectConnection(auth, connectionId) {
  const connection = await findConnection(auth, connectionId)
  const { MetaPage } = getModels()
  const pages = await MetaPage.findAll({
    where: {
      companyId: auth.companyId,
      connectionId: connection.id,
      status: metaPageStatuses.connected,
    },
  })
  for (const page of pages) {
    await disconnectPage(auth, page.id)
  }
  connection.status = metaConnectionStatuses.disconnected
  connection.disconnectedAt = new Date()
  connection.tokenCipher = null
  await connection.save()
  return presentConnection(connection)
}

module.exports = {
  connectSelectedPages,
  consumeState,
  createProfile,
  disconnectConnection,
  disconnectPage,
  handleOAuthCallback,
  listAvailablePages,
  listConnections,
  listPages,
  listProfiles,
  missingFromGranted,
  presentConnection,
  presentPage,
  presentProfile,
  removeProfile,
  startOAuth,
  updateProfile,
}
