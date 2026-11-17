const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const {
  assertWhatsAppEmbeddedSignupReady,
  presentEmbeddedSignupClientConfig,
} = require('../config/whatsappEnv')
const { getModels } = require('../models')
const {
  whatsappAuditActions,
  whatsappAuditOutcomes,
  whatsappTokenSources,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  debugAccessToken,
  exchangeEmbeddedSignupCode,
  listWhatsAppPhoneNumbers,
  readWhatsAppBusinessAccount,
} = require('./metaGraph')
const { writeWhatsAppAudit, sanitizeAuditDetail } = require('./whatsappAuditService')
const {
  applyEncryptedAccessToken,
  presentWhatsAppConfigForApi,
} = require('./whatsappConfigService')
const {
  createEmbeddedSignupSession,
  consumeEmbeddedSignupSession,
} = require('./whatsappEmbeddedSignupSessionService')

const DEFAULT_BUSINESS_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60

function readTextId(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, key)) {
    return null
  }
  const value = body[key]
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new AppError(errors.whatsappSignupPayloadInvalid, 400)
  }
  const text = String(value).trim()
  if (!text || text.length > 64) {
    throw new AppError(errors.whatsappSignupPayloadInvalid, 400)
  }
  return text
}

/**
 * Starts Embedded Signup: creates nonce session and returns non-secret SDK config.
 *
 * @param {object} auth
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function startEmbeddedSignup(auth, meta = {}) {
  const platform = assertWhatsAppEmbeddedSignupReady()
  const session = await createEmbeddedSignupSession(auth, meta)
  const client = presentEmbeddedSignupClientConfig()

  await writeWhatsAppAudit({
    companyId: auth.companyId,
    actorUserId: auth.userId,
    action: whatsappAuditActions.signupStart,
    target: session.sessionId,
    outcome: whatsappAuditOutcomes.success,
    ip: meta.ip,
    requestId: meta.requestId,
    detail: 'Embedded Signup session created.',
  })

  return {
    message: messages.whatsappSignupStarted,
    nonce: session.nonce,
    expiresAt: session.expiresAt,
    appId: platform.appId,
    configId: platform.configId,
    graphApiVersion: platform.graphApiVersion,
    extras: client.extras,
    loginOptions: client.loginOptions,
  }
}

async function auditFailure(auth, meta, action, target, detail) {
  try {
    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action,
      target: target || 'embedded_signup',
      outcome: whatsappAuditOutcomes.failure,
      ip: meta.ip,
      requestId: meta.requestId,
      detail: sanitizeAuditDetail(detail),
    })
  } catch {
    // Never block the primary error path on audit write failure.
  }
}

function assertRequiredScopes(grantedScopes, requiredScopes) {
  const granted = new Set((grantedScopes || []).map((item) => String(item)))
  const missing = requiredScopes.filter((scope) => !granted.has(scope))
  if (missing.length > 0) {
    throw new AppError(errors.whatsappSignupPermissionsMissing, 403)
  }
}

/**
 * Completes Embedded Signup: consume nonce, exchange code, verify assets, encrypt token.
 *
 * @param {object} auth
 * @param {object} body
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function completeEmbeddedSignup(auth, body, meta = {}) {
  const platform = assertWhatsAppEmbeddedSignupReady()
  const nonce = typeof body?.nonce === 'string' ? body.nonce.trim() : ''
  const authorizationCode = typeof body?.authorizationCode === 'string'
    ? body.authorizationCode.trim()
    : (typeof body?.code === 'string' ? body.code.trim() : '')
  const claimedWabaId = readTextId(body, 'wabaId')
  const claimedPhoneNumberId = readTextId(body, 'phoneNumberId')
  const claimedBusinessId = readTextId(body, 'businessId')

  if (!nonce || !authorizationCode) {
    throw new AppError(errors.whatsappSignupPayloadInvalid, 400)
  }
  if (!claimedWabaId || !claimedPhoneNumberId) {
    throw new AppError(errors.whatsappSignupPayloadInvalid, 400)
  }

  // Single-use reservation before any Graph call (prevents concurrent completion).
  let session
  try {
    session = await consumeEmbeddedSignupSession(auth, nonce)
  } catch (error) {
    await auditFailure(
      auth,
      meta,
      whatsappAuditActions.signupConsume,
      claimedWabaId,
      error.message || 'Signup session rejected.',
    )
    throw error
  }

  let accessToken = null
  try {
    const exchanged = await exchangeEmbeddedSignupCode({
      appId: platform.appId,
      appSecret: platform.appSecret,
      code: authorizationCode,
      graphVersion: platform.graphApiVersion,
    })
    accessToken = exchanged.accessToken
    const exchangedExpiresIn = exchanged.expiresIn

    let tokenMeta
    try {
      tokenMeta = await debugAccessToken({
        appId: platform.appId,
        appSecret: platform.appSecret,
        inputToken: accessToken,
        graphVersion: platform.graphApiVersion,
      })
    } catch (error) {
      if (error instanceof AppError) {
        throw new AppError(errors.whatsappSignupExchangeFailed, error.statusCode || 502)
      }
      throw new AppError(errors.whatsappSignupExchangeFailed, 502)
    }

    if (!tokenMeta.isValid) {
      throw new AppError(errors.whatsappSignupExchangeFailed, 400)
    }
    if (tokenMeta.appId && tokenMeta.appId !== platform.appId) {
      throw new AppError(errors.whatsappSignupExchangeFailed, 400)
    }
    assertRequiredScopes(tokenMeta.scopes, platform.requiredScopes)

    if (
      tokenMeta.targetIds.length > 0
      && !tokenMeta.targetIds.includes(claimedWabaId)
    ) {
      throw new AppError(errors.whatsappSignupWabaInvalid, 400)
    }

    let waba
    try {
      waba = await readWhatsAppBusinessAccount({
        accessToken,
        wabaId: claimedWabaId,
        graphVersion: platform.graphApiVersion,
      })
    } catch (error) {
      if (error instanceof AppError && error.code === 'META_PERMISSION_MISSING') {
        throw new AppError(errors.whatsappSignupPermissionsMissing, 403)
      }
      if (error instanceof AppError && error.message === errors.whatsappSignupWabaInvalid) {
        throw error
      }
      throw new AppError(errors.whatsappSignupWabaInvalid, 400)
    }
    if (waba.id !== claimedWabaId) {
      throw new AppError(errors.whatsappSignupWabaInvalid, 400)
    }

    let phoneMatch
    try {
      const listed = await listWhatsAppPhoneNumbers({
        accessToken,
        wabaId: claimedWabaId,
        phoneNumberId: claimedPhoneNumberId,
        graphVersion: platform.graphApiVersion,
      })
      phoneMatch = listed.matched
    } catch (error) {
      if (error instanceof AppError && error.code === 'META_PERMISSION_MISSING') {
        throw new AppError(errors.whatsappSignupPermissionsMissing, 403)
      }
      throw new AppError(errors.whatsappSignupPhoneInvalid, 400)
    }
    if (!phoneMatch) {
      throw new AppError(errors.whatsappSignupPhoneInvalid, 400)
    }

    const { WhatsAppCompanyConfig, sequelize } = getModels()
    const conflictWaba = await WhatsAppCompanyConfig.findOne({
      where: {
        wabaId: claimedWabaId,
        companyId: { [Op.ne]: auth.companyId },
      },
    })
    if (conflictWaba) {
      throw new AppError(errors.whatsappWabaTaken, 409)
    }
    const conflictPhone = await WhatsAppCompanyConfig.findOne({
      where: {
        phoneNumberId: claimedPhoneNumberId,
        companyId: { [Op.ne]: auth.companyId },
      },
    })
    if (conflictPhone) {
      throw new AppError(errors.whatsappPhoneTaken, 409)
    }

    const expiresInSeconds = typeof exchangedExpiresIn === 'number' && exchangedExpiresIn > 0
      ? exchangedExpiresIn
      : (
        typeof tokenMeta.expiresAt === 'number' && tokenMeta.expiresAt > 0
          ? Math.max(0, tokenMeta.expiresAt - Math.floor(Date.now() / 1000))
          : DEFAULT_BUSINESS_TOKEN_TTL_SECONDS
      )
    const tokenExpiresAt = expiresInSeconds > 0
      ? new Date(Date.now() + expiresInSeconds * 1000)
      : null

    const config = await sequelize.transaction(async (transaction) => {
      let row = await WhatsAppCompanyConfig.findOne({
        where: { companyId: auth.companyId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
      if (!row) {
        row = WhatsAppCompanyConfig.build({
          id: uuidv4(),
          companyId: auth.companyId,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
      }

      row.wabaId = claimedWabaId
      row.phoneNumberId = claimedPhoneNumberId
      row.businessId = claimedBusinessId
      row.displayPhoneNumber = phoneMatch.displayPhoneNumber
      row.displayName = phoneMatch.verifiedName || waba.name || null
      row.qualityRating = phoneMatch.qualityRating
      row.messagingLimitTier = phoneMatch.messagingLimitTier
      row.isActive = true
      row.connectedAt = new Date()
      row.lastError = ''
      row.tokenExpiresAt = tokenExpiresAt
      row.updatedBy = auth.userId
      applyEncryptedAccessToken(row, accessToken, whatsappTokenSources.embeddedSignup)
      await row.save({ transaction })

      await writeWhatsAppAudit({
        companyId: auth.companyId,
        actorUserId: auth.userId,
        action: whatsappAuditActions.connect,
        target: claimedPhoneNumberId,
        outcome: whatsappAuditOutcomes.success,
        ip: meta.ip,
        requestId: meta.requestId,
        detail: sanitizeAuditDetail(JSON.stringify({
          wabaId: claimedWabaId,
          phoneNumberId: claimedPhoneNumberId,
          businessId: claimedBusinessId,
          sessionId: session.id,
          tokenSource: whatsappTokenSources.embeddedSignup,
        })),
      }, { transaction })

      return row
    })

    return {
      message: messages.whatsappConnected,
      config: await presentWhatsAppConfigForApi(config, auth.companyId),
    }
  } catch (error) {
    await auditFailure(
      auth,
      meta,
      whatsappAuditActions.connect,
      claimedPhoneNumberId || claimedWabaId,
      error.message || 'Embedded Signup completion failed.',
    )
    if (error instanceof AppError) {
      throw error
    }
    throw new AppError(errors.whatsappSignupExchangeFailed, 502)
  } finally {
    accessToken = null
  }
}

/**
 * Safe public bootstrap for the integration page (enabled flag + non-secret IDs when ready).
 */
function getEmbeddedSignupBootstrap() {
  return presentEmbeddedSignupClientConfig()
}

module.exports = {
  startEmbeddedSignup,
  completeEmbeddedSignup,
  getEmbeddedSignupBootstrap,
  DEFAULT_BUSINESS_TOKEN_TTL_SECONDS,
}
