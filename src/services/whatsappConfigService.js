const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')
const {
  whatsappAuditActions,
  whatsappAuditOutcomes,
  whatsappOutboxStatuses,
  whatsappPhoneRegistrationStatuses,
  whatsappTokenSources,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  isWhatsAppRecipientPhone,
  normalizePhone,
  normalizeWhatsAppRecipientPhone,
  readText,
} = require('../utils/helpers')
const { encryptSecret, decryptSecret } = require('../utils/metaSecrets')
const { isWhatsAppWebhookConfigured, readWhatsAppGraphVersion } = require('../config/whatsappEnv')
const { writeWhatsAppAudit, sanitizeAuditDetail } = require('./whatsappAuditService')
const {
  sendWhatsAppTemplateMessage,
  verifyWhatsAppPhoneNumber,
} = require('./whatsappCloudClient')

/**
 * Public config shape — never includes cipher/token fields.
 *
 * @param {object|null} config
 * @returns {object}
 */
function deriveConnectionStatus(config, credentialsReady, registered) {
  if (!config || !credentialsReady) {
    return 'not_configured'
  }
  if (config.phoneRegistrationStatus === whatsappPhoneRegistrationStatuses.failed) {
    return 'error'
  }
  if (registered) {
    return 'connected'
  }
  return 'configured'
}

function presentWhatsAppConfig(config) {
  if (!config) {
    return {
      connected: false,
      credentialsReady: false,
      connectionStatus: 'not_configured',
      isActive: false,
      tokenStored: false,
      tokenSource: null,
      wabaId: null,
      phoneNumberId: null,
      businessId: null,
      displayPhoneNumber: null,
      displayName: null,
      qualityRating: null,
      messagingLimitTier: null,
      defaultLanguage: 'en',
      metaAssignEnabled: false,
      transferEnabled: false,
      connectedAt: null,
      lastError: '',
      phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.unregistered,
      phoneRegisteredAt: null,
      phoneRegistrationError: '',
      wabaWebhookSubscribed: false,
      wabaWebhookSubscribedAt: null,
      webhookConfigured: isWhatsAppWebhookConfigured(),
      webhookLastEventAt: null,
      webhookLastError: '',
      templatesLastSyncedAt: null,
      templatesSyncError: '',
      messagingReady: false,
      manualConfigAllowed: isManualTokenAllowed(),
      requiredScopes: messages.whatsappRequiredScopes.split(',').map((item) => item.trim()),
      updatedAt: null,
    }
  }
  const phoneRegistrationStatus = config.phoneRegistrationStatus
    || whatsappPhoneRegistrationStatuses.unregistered
  const registered = phoneRegistrationStatus === whatsappPhoneRegistrationStatuses.registered
  const credentialsReady = Boolean(config.isActive && config.tokenStored && config.wabaId && config.phoneNumberId)
  // API `connected` = credentials present (compat). UI should use connectionStatus / messagingReady.
  const connected = credentialsReady
  return {
    connected,
    credentialsReady,
    connectionStatus: deriveConnectionStatus(config, credentialsReady, registered),
    isActive: Boolean(config.isActive),
    tokenStored: Boolean(config.tokenStored),
    tokenSource: config.tokenSource || null,
    wabaId: config.wabaId || null,
    phoneNumberId: config.phoneNumberId || null,
    businessId: config.businessId || null,
    displayPhoneNumber: config.displayPhoneNumber || null,
    displayName: config.displayName || null,
    qualityRating: config.qualityRating || null,
    messagingLimitTier: config.messagingLimitTier || null,
    defaultLanguage: config.defaultLanguage || 'en',
    metaAssignEnabled: Boolean(config.metaAssignEnabled),
    transferEnabled: Boolean(config.transferEnabled),
    connectedAt: config.connectedAt || null,
    lastError: config.lastError || '',
    phoneRegistrationStatus,
    phoneRegisteredAt: config.phoneRegisteredAt || null,
    phoneRegistrationError: config.phoneRegistrationError || '',
    wabaWebhookSubscribed: Boolean(config.wabaWebhookSubscribed),
    wabaWebhookSubscribedAt: config.wabaWebhookSubscribedAt || null,
    webhookConfigured: isWhatsAppWebhookConfigured(),
    webhookLastEventAt: config.webhookLastEventAt || null,
    webhookLastError: config.webhookLastError || '',
    templatesLastSyncedAt: config.templatesLastSyncedAt || null,
    templatesSyncError: config.templatesSyncError || '',
    messagingReady: Boolean(credentialsReady && registered),
    manualConfigAllowed: isManualTokenAllowed(),
    requiredScopes: messages.whatsappRequiredScopes.split(',').map((item) => item.trim()),
    updatedAt: config.updatedAt || null,
  }
}

/**
 * @param {object} auth
 * @returns {Promise<object|null>}
 */
async function findCompanyConfig(auth) {
  const { WhatsAppCompanyConfig } = getModels()
  return WhatsAppCompanyConfig.findOne({ where: { companyId: auth.companyId } })
}

/**
 * @param {object} auth
 * @returns {Promise<object>}
 */
async function presentWhatsAppConfigForApi(config, companyId) {
  const presented = presentWhatsAppConfig(config)
  // Lazy require avoids circular import with outbox → config → assignment.
  const { buildWorkflowStatus } = require('./whatsappAssignmentNotificationService')
  presented.workflows = await buildWorkflowStatus(
    companyId || (config && config.companyId),
    presented,
  )
  return presented
}

async function getWhatsAppConfig(auth) {
  const config = await findCompanyConfig(auth)
  return presentWhatsAppConfigForApi(config, auth.companyId)
}

function readOptionalBoolean(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, key)) {
    return undefined
  }
  if (typeof body[key] !== 'boolean') {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }
  return body[key]
}

/**
 * Updates workflow toggles / default language for an existing company config.
 *
 * @param {object} auth
 * @param {object} body
 * @param {{ ip?: string, requestId?: string }} [meta]
 * @returns {Promise<object>}
 */
async function updateWhatsAppConfig(auth, body, meta = {}) {
  const config = await findCompanyConfig(auth)
  if (!config) {
    throw new AppError(errors.whatsappConfigNotFound, 404)
  }

  const metaAssignEnabled = readOptionalBoolean(body, 'metaAssignEnabled')
  const transferEnabled = readOptionalBoolean(body, 'transferEnabled')
  let defaultLanguage
  if (Object.prototype.hasOwnProperty.call(body || {}, 'defaultLanguage')) {
    defaultLanguage = readText(body, 'defaultLanguage')
    if (!defaultLanguage || defaultLanguage.length > 16 || !/^[A-Za-z]{2}([_-][A-Za-z0-9]+)?$/.test(defaultLanguage)) {
      throw new AppError(errors.whatsappLanguageInvalid, 400)
    }
  }

  if (
    metaAssignEnabled === undefined
    && transferEnabled === undefined
    && defaultLanguage === undefined
  ) {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }

  if (metaAssignEnabled !== undefined) {
    config.metaAssignEnabled = metaAssignEnabled
  }
  if (transferEnabled !== undefined) {
    config.transferEnabled = transferEnabled
  }
  if (defaultLanguage !== undefined) {
    config.defaultLanguage = defaultLanguage
  }
  config.updatedBy = auth.userId
  await config.save()

  await writeWhatsAppAudit({
    companyId: auth.companyId,
    actorUserId: auth.userId,
    action: whatsappAuditActions.configUpdate,
    target: 'whatsapp_company_configs',
    outcome: whatsappAuditOutcomes.success,
    ip: meta.ip,
    requestId: meta.requestId,
    detail: sanitizeAuditDetail(JSON.stringify({
      metaAssignEnabled: config.metaAssignEnabled,
      transferEnabled: config.transferEnabled,
      defaultLanguage: config.defaultLanguage,
    })),
  })

  return presentWhatsAppConfigForApi(config, auth.companyId)
}

/**
 * Deactivates WhatsApp for the company, cancels pending outbox, clears secrets and
 * releases globally unique WABA/phone IDs. Preserves logs and audit history.
 *
 * @param {object} auth
 * @param {{ ip?: string, requestId?: string }} [meta]
 * @returns {Promise<object>}
 */
async function disconnectWhatsApp(auth, meta = {}) {
  const { sequelize, WhatsAppCompanyConfig, WhatsAppOutbox } = getModels()
  const config = await findCompanyConfig(auth)
  if (!config) {
    throw new AppError(errors.whatsappConfigNotFound, 404)
  }

  const previousWaba = config.wabaId || ''
  const previousPhone = config.phoneNumberId || ''

  await sequelize.transaction(async (transaction) => {
    await WhatsAppOutbox.update({
      status: whatsappOutboxStatuses.cancelled,
      lockedAt: null,
      lockedBy: null,
      lockExpiresAt: null,
      lockToken: null,
      lastError: 'Cancelled because WhatsApp was disconnected.',
    }, {
      where: {
        companyId: auth.companyId,
        status: {
          [Op.in]: [whatsappOutboxStatuses.queued, whatsappOutboxStatuses.processing],
        },
      },
      transaction,
    })

    config.wabaId = null
    config.phoneNumberId = null
    config.businessId = null
    config.displayPhoneNumber = null
    config.displayName = null
    config.qualityRating = null
    config.messagingLimitTier = null
    config.accessTokenCipher = null
    config.accessTokenIv = null
    config.accessTokenTag = null
    config.tokenStored = false
    config.tokenSource = null
    config.tokenExpiresAt = null
    config.isActive = false
    config.connectedAt = null
    config.lastError = ''
    config.phoneRegistrationStatus = whatsappPhoneRegistrationStatuses.unregistered
    config.phoneRegisteredAt = null
    config.phoneRegistrationError = ''
    config.wabaWebhookSubscribed = false
    config.wabaWebhookSubscribedAt = null
    config.webhookLastEventAt = null
    config.webhookLastError = ''
    config.templatesLastSyncedAt = null
    config.templatesSyncError = ''
    config.registrationLockToken = null
    config.registrationLockedAt = null
    config.registrationLockExpiresAt = null
    config.updatedBy = auth.userId
    await config.save({ transaction })

    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.disconnect,
      target: previousPhone || previousWaba || 'whatsapp_company_configs',
      outcome: whatsappAuditOutcomes.success,
      ip: meta.ip,
      requestId: meta.requestId,
      detail: 'Disconnected; WABA and phone identifiers released.',
    }, { transaction })
  })

  const refreshed = await findCompanyConfig(auth)
  return presentWhatsAppConfigForApi(refreshed, auth.companyId)
}

/**
 * Stores an encrypted access token on a config row (P2/P8 / tests).
 * Reuses Meta AES-GCM helper without changing Lead Ads behavior.
 *
 * @param {object} config Sequelize model instance
 * @param {string} plainToken
 * @param {string} tokenSource
 */
function applyEncryptedAccessToken(config, plainToken, tokenSource) {
  if (!plainToken || typeof plainToken !== 'string') {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }
  const allowed = Object.values(whatsappTokenSources)
  if (!allowed.includes(tokenSource)) {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }
  const encrypted = encryptSecret(plainToken)
  config.accessTokenCipher = encrypted.cipherText
  config.accessTokenIv = encrypted.iv
  config.accessTokenTag = encrypted.tag
  config.keyVersion = encrypted.keyVersion
  config.tokenStored = true
  config.tokenSource = tokenSource
}

/**
 * Decrypts company WhatsApp token for server-side Cloud API use only (P3+).
 *
 * @param {object} config
 * @returns {string}
 */
function readDecryptedAccessToken(config) {
  if (!config || !config.tokenStored) {
    throw new AppError(errors.whatsappConfigNotFound, 404)
  }
  return decryptSecret({
    cipherText: config.accessTokenCipher,
    iv: config.accessTokenIv,
    tag: config.accessTokenTag,
    keyVersion: config.keyVersion,
  })
}

/**
 * Dev/test helper to upsert a connected config with uniqueness checks.
 * Not exposed as a production API in P1.
 *
 * @param {object} auth
 * @param {object} details
 * @returns {Promise<object>}
 */
async function upsertConnectedConfigForTests(auth, details) {
  const { WhatsAppCompanyConfig } = getModels()
  const wabaId = String(details.wabaId || '').trim()
  const phoneNumberId = String(details.phoneNumberId || '').trim()
  if (!wabaId || !phoneNumberId || !details.accessToken) {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }

  const conflictWaba = await WhatsAppCompanyConfig.findOne({
    where: {
      wabaId,
      companyId: { [Op.ne]: auth.companyId },
    },
  })
  if (conflictWaba) {
    throw new AppError(errors.whatsappWabaTaken, 409)
  }
  const conflictPhone = await WhatsAppCompanyConfig.findOne({
    where: {
      phoneNumberId,
      companyId: { [Op.ne]: auth.companyId },
    },
  })
  if (conflictPhone) {
    throw new AppError(errors.whatsappPhoneTaken, 409)
  }

  let config = await findCompanyConfig(auth)
  if (!config) {
    config = WhatsAppCompanyConfig.build({
      id: uuidv4(),
      companyId: auth.companyId,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
  }
  config.wabaId = wabaId
  config.phoneNumberId = phoneNumberId
  config.businessId = details.businessId || null
  config.displayPhoneNumber = details.displayPhoneNumber || null
  config.displayName = details.displayName || null
  config.isActive = true
  config.connectedAt = new Date()
  config.updatedBy = auth.userId
  if (details.phoneRegistrationStatus) {
    config.phoneRegistrationStatus = details.phoneRegistrationStatus
  }
  if (details.phoneRegisteredAt) {
    config.phoneRegisteredAt = details.phoneRegisteredAt
  }
  applyEncryptedAccessToken(
    config,
    details.accessToken,
    details.tokenSource || whatsappTokenSources.manualDev,
  )
  await config.save()
  return presentWhatsAppConfig(config)
}

/**
 * Manual Cloud API config is the primary connection path.
 * Production stays locked unless WHATSAPP_MANUAL_TOKEN_ENABLED=1.
 *
 * @returns {boolean}
 */
function isManualTokenAllowed() {
  if (process.env.NODE_ENV === 'production') {
    return String(process.env.WHATSAPP_MANUAL_TOKEN_ENABLED || '').trim() === '1'
  }
  return true
}

function assertManualTokenAllowed() {
  if (!isManualTokenAllowed()) {
    throw new AppError(errors.whatsappManualTokenForbidden, 403)
  }
}

function readMetaNumericId(body, key, requiredError) {
  const value = readText(body, key)
  if (!value) {
    if (requiredError) {
      throw new AppError(requiredError, 400)
    }
    return ''
  }
  if (!/^\d{5,32}$/.test(value)) {
    throw new AppError(errors.whatsappIdInvalid, 400)
  }
  return value
}

/**
 * Saves manual WhatsApp Cloud API credentials for the company.
 * displayPhoneNumber is Meta-owned and ignored from the client body.
 *
 * @param {object} auth
 * @param {object} body
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function saveManualWhatsAppConfig(auth, body, meta = {}) {
  assertManualTokenAllowed()
  const { WhatsAppCompanyConfig } = getModels()
  const wabaId = readMetaNumericId(body, 'wabaId', errors.whatsappWabaRequired)
  const phoneNumberId = readMetaNumericId(body, 'phoneNumberId', errors.whatsappPhoneNumberIdRequired)
  const accessTokenRaw = readText(body, 'accessToken')
  const isActive = Object.prototype.hasOwnProperty.call(body || {}, 'isActive')
    ? Boolean(body.isActive)
    : true

  const conflictWaba = await WhatsAppCompanyConfig.findOne({
    where: { wabaId, companyId: { [Op.ne]: auth.companyId } },
  })
  if (conflictWaba) {
    throw new AppError(errors.whatsappWabaTaken, 409)
  }
  const conflictPhone = await WhatsAppCompanyConfig.findOne({
    where: { phoneNumberId, companyId: { [Op.ne]: auth.companyId } },
  })
  if (conflictPhone) {
    throw new AppError(errors.whatsappPhoneTaken, 409)
  }

  let config = await findCompanyConfig(auth)
  const creating = !config
  if (!config) {
    if (!accessTokenRaw) {
      throw new AppError(errors.whatsappAccessTokenRequired, 400)
    }
    config = WhatsAppCompanyConfig.build({
      id: uuidv4(),
      companyId: auth.companyId,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
  }

  const phoneChanged = Boolean(config.phoneNumberId)
    && String(config.phoneNumberId) !== String(phoneNumberId)
  config.wabaId = wabaId
  config.phoneNumberId = phoneNumberId
  config.isActive = isActive
  config.updatedBy = auth.userId
  if (!config.connectedAt) {
    config.connectedAt = new Date()
  }
  if (accessTokenRaw) {
    applyEncryptedAccessToken(config, accessTokenRaw, whatsappTokenSources.manualDev)
  } else if (!config.tokenStored) {
    throw new AppError(errors.whatsappAccessTokenRequired, 400)
  }

  // Credentials saved — require Verify Connection before messagingReady/Connected.
  if (creating || phoneChanged || accessTokenRaw) {
    config.displayPhoneNumber = phoneChanged ? null : config.displayPhoneNumber
    if (phoneChanged) {
      config.displayName = null
      config.qualityRating = null
    }
    config.phoneRegistrationStatus = whatsappPhoneRegistrationStatuses.unregistered
    config.phoneRegisteredAt = null
    config.phoneRegistrationError = ''
    config.lastError = ''
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, 'metaAssignEnabled')) {
    config.metaAssignEnabled = Boolean(body.metaAssignEnabled)
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'transferEnabled')) {
    config.transferEnabled = Boolean(body.transferEnabled)
  }

  await config.save()
  await writeWhatsAppAudit({
    companyId: auth.companyId,
    actorUserId: auth.userId,
    action: whatsappAuditActions.manualConfigSave,
    target: 'whatsapp_company_configs',
    outcome: whatsappAuditOutcomes.success,
    ip: meta.ip,
    requestId: meta.requestId,
    detail: sanitizeAuditDetail(JSON.stringify({
      wabaId,
      phoneNumberId,
      tokenUpdated: Boolean(accessTokenRaw),
      isActive,
    })),
  })

  return {
    message: messages.whatsappManualConfigSaved,
    config: await presentWhatsAppConfigForApi(config, auth.companyId),
  }
}

/**
 * Verifies saved credentials against Meta Graph and loads the connected display number.
 *
 * @param {object} auth
 * @param {{ ip?: string, requestId?: string, fetchImpl?: Function }} [options]
 */
async function verifyWhatsAppConnection(auth, options = {}) {
  assertManualTokenAllowed()
  const config = await findCompanyConfig(auth)
  if (!config || !config.tokenStored || !config.phoneNumberId) {
    throw new AppError(errors.whatsappNotConnected, 400)
  }
  let accessToken
  try {
    accessToken = readDecryptedAccessToken(config)
  } catch (_error) {
    throw new AppError(errors.whatsappNotConnected, 400)
  }

  const previousFetch = options.fetchImpl
  let result
  try {
    if (previousFetch) {
      const cloud = require('./whatsappCloudClient')
      cloud.setWhatsAppFetchImpl(previousFetch)
    }
    result = await verifyWhatsAppPhoneNumber({
      accessToken,
      phoneNumberId: config.phoneNumberId,
      graphVersion: readWhatsAppGraphVersion(),
    })
    if (result.displayPhoneNumber) {
      config.displayPhoneNumber = normalizePhone(result.displayPhoneNumber) || String(result.displayPhoneNumber).trim()
    }
    if (result.verifiedName) {
      config.displayName = String(result.verifiedName).slice(0, 160)
    }
    if (result.qualityRating) {
      config.qualityRating = String(result.qualityRating).slice(0, 32)
    }
    // Manual Cloud API numbers become messaging-ready after successful Graph verify.
    config.phoneRegistrationStatus = whatsappPhoneRegistrationStatuses.registered
    config.phoneRegisteredAt = new Date()
    config.phoneRegistrationError = ''
    config.lastError = ''
    config.isActive = true
    config.updatedBy = auth.userId
    await config.save()
    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.connectionVerify,
      target: config.phoneNumberId,
      outcome: whatsappAuditOutcomes.success,
      ip: options.ip,
      requestId: options.requestId,
      detail: 'Graph phone number verified',
    })
    return {
      message: messages.whatsappConnectionVerified,
      verified: true,
      displayPhoneNumber: config.displayPhoneNumber || '',
      config: await presentWhatsAppConfigForApi(config, auth.companyId),
    }
  } catch (error) {
    config.phoneRegistrationStatus = whatsappPhoneRegistrationStatuses.failed
    config.phoneRegistrationError = error && error.message
      ? String(error.message).slice(0, 500)
      : errors.whatsappVerifyFailed
    config.lastError = config.phoneRegistrationError
    config.updatedBy = auth.userId
    await config.save()
    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.connectionVerify,
      target: config.phoneNumberId || 'whatsapp_company_configs',
      outcome: whatsappAuditOutcomes.failure,
      ip: options.ip,
      requestId: options.requestId,
      detail: sanitizeAuditDetail(config.phoneRegistrationError),
    })
    throw new AppError(
      config.phoneRegistrationError || errors.whatsappVerifyFailed,
      error && error.statusCode ? error.statusCode : 502,
    )
  } finally {
    if (previousFetch) {
      const cloud = require('./whatsappCloudClient')
      cloud.resetWhatsAppFetchImpl()
    }
    accessToken = null
  }
}

/**
 * Sends Meta hello_world test template from the company Phone Number ID.
 *
 * @param {object} auth
 * @param {object} body
 * @param {{ ip?: string, requestId?: string, fetchImpl?: Function }} [options]
 */
async function sendWhatsAppTestMessage(auth, body, options = {}) {
  assertManualTokenAllowed()
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(errors.whatsappTestRecipientRequired, 400)
  }
  const recipientRaw = readText(body, 'recipientPhone') || readText(body, 'to')
  if (!recipientRaw) {
    throw new AppError(errors.whatsappTestRecipientRequired, 400)
  }
  const recipient = normalizeWhatsAppRecipientPhone(recipientRaw)
  if (!isWhatsAppRecipientPhone(recipient)) {
    throw new AppError(errors.whatsappRecipientInvalid, 400)
  }

  const config = await findCompanyConfig(auth)
  if (!config || !config.tokenStored || !config.phoneNumberId || !config.isActive) {
    throw new AppError(errors.whatsappNotConnected, 400)
  }
  if (config.phoneRegistrationStatus !== whatsappPhoneRegistrationStatuses.registered) {
    throw new AppError(errors.whatsappPhoneNotRegistered, 400)
  }

  let accessToken
  try {
    accessToken = readDecryptedAccessToken(config)
  } catch (_error) {
    throw new AppError(errors.whatsappNotConnected, 400)
  }

  const previousFetch = options.fetchImpl
  try {
    if (previousFetch) {
      const cloud = require('./whatsappCloudClient')
      cloud.setWhatsAppFetchImpl(previousFetch)
    }
    const sent = await sendWhatsAppTemplateMessage({
      accessToken,
      phoneNumberId: config.phoneNumberId,
      to: recipient,
      templateName: messages.whatsappTestTemplateName,
      language: messages.whatsappTestTemplateLanguage,
      bodyParameters: [],
      graphVersion: readWhatsAppGraphVersion(),
    })
    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.testMessage,
      target: config.phoneNumberId,
      outcome: whatsappAuditOutcomes.success,
      ip: options.ip,
      requestId: options.requestId,
      detail: sanitizeAuditDetail(JSON.stringify({
        providerMessageId: sent.providerMessageId,
        recipientMasked: `${recipient.slice(0, 4)}…${recipient.slice(-2)}`,
      })),
    })
    return {
      message: messages.whatsappTestMessageSent,
      sent: true,
      providerMessageId: sent.providerMessageId,
      recipientMasked: `${recipient.slice(0, 4)}…${recipient.slice(-2)}`,
    }
  } catch (error) {
    throw new AppError(
      error && error.message ? error.message : errors.whatsappTestMessageFailed,
      error && error.statusCode ? error.statusCode : 502,
    )
  } finally {
    if (previousFetch) {
      const cloud = require('./whatsappCloudClient')
      cloud.resetWhatsAppFetchImpl()
    }
    accessToken = null
  }
}

module.exports = {
  presentWhatsAppConfig,
  presentWhatsAppConfigForApi,
  getWhatsAppConfig,
  updateWhatsAppConfig,
  saveManualWhatsAppConfig,
  verifyWhatsAppConnection,
  sendWhatsAppTestMessage,
  disconnectWhatsApp,
  applyEncryptedAccessToken,
  readDecryptedAccessToken,
  upsertConnectedConfigForTests,
  isManualTokenAllowed,
  assertManualTokenAllowed,
  findCompanyConfig,
}
