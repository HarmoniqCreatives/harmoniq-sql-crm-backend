const { v4: uuidv4 } = require('uuid')
const { Op } = require('sequelize')
const { security } = require('../config/security')
const {
  readWhatsAppGraphVersion,
  readWhatsAppEmbeddedSignupConfig,
  isWhatsAppWebhookConfigured,
} = require('../config/whatsappEnv')
const { getModels } = require('../models')
const {
  whatsappAuditActions,
  whatsappAuditOutcomes,
  whatsappPhoneRegistrationStatuses,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  registerWhatsAppPhoneNumber,
  subscribeWhatsAppWabaApps,
  listWhatsAppWabaSubscribedApps,
} = require('./whatsappCloudClient')
const { writeWhatsAppAudit, sanitizeAuditDetail } = require('./whatsappAuditService')
const {
  findCompanyConfig,
  presentWhatsAppConfigForApi,
  readDecryptedAccessToken,
} = require('./whatsappConfigService')

function assertActiveConnection(config) {
  if (!config || !config.isActive || !config.tokenStored || !config.wabaId || !config.phoneNumberId) {
    throw new AppError(errors.whatsappNotConnected, 400)
  }
  if (config.tokenExpiresAt && new Date(config.tokenExpiresAt).getTime() <= Date.now()) {
    throw new AppError(errors.whatsappTokenExpired, 401)
  }
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    throw new AppError(errors.whatsappPinInvalid, 400)
  }
}

async function acquireRegistrationLock(config, auth) {
  const { WhatsAppCompanyConfig } = getModels()
  const now = new Date()
  const lockToken = uuidv4()
  const lockExpiresAt = new Date(now.getTime() + security.whatsappRegistrationLeaseMs)
  const [updated] = await WhatsAppCompanyConfig.update({
    registrationLockToken: lockToken,
    registrationLockedAt: now,
    registrationLockExpiresAt: lockExpiresAt,
    phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.pending,
    phoneRegistrationError: '',
    updatedBy: auth.userId,
  }, {
    where: {
      id: config.id,
      companyId: auth.companyId,
      [Op.or]: [
        { registrationLockToken: null },
        { registrationLockExpiresAt: null },
        { registrationLockExpiresAt: { [Op.lte]: now } },
      ],
    },
  })
  if (!updated) {
    throw new AppError(errors.whatsappRegistrationBusy, 409)
  }
  await config.reload()
  return lockToken
}

async function releaseRegistrationLock(config, lockToken, patch = {}) {
  const { WhatsAppCompanyConfig } = getModels()
  await WhatsAppCompanyConfig.update({
    registrationLockToken: null,
    registrationLockedAt: null,
    registrationLockExpiresAt: null,
    ...patch,
  }, {
    where: {
      id: config.id,
      companyId: config.companyId,
      registrationLockToken: lockToken,
    },
  })
  await config.reload()
}

/**
 * @param {object} auth
 * @returns {Promise<object>}
 */
async function getRegistrationStatus(auth) {
  const config = await findCompanyConfig(auth)
  return presentWhatsAppConfigForApi(config, auth.companyId)
}

/**
 * Registers the connected phone for Cloud API and attempts WABA subscribed_apps.
 * PIN is never persisted, returned, or written to audit detail.
 *
 * @param {object} auth
 * @param {{ pin: string }} body
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function registerCompanyPhone(auth, body, meta = {}) {
  const config = await findCompanyConfig(auth)
  assertActiveConnection(config)
  validatePin(body?.pin)

  const lockToken = await acquireRegistrationLock(config, auth)
  let accessToken = null
  try {
    accessToken = readDecryptedAccessToken(config)
    const graphVersion = readWhatsAppGraphVersion()

    await registerWhatsAppPhoneNumber({
      accessToken,
      phoneNumberId: config.phoneNumberId,
      pin: body.pin,
      graphVersion,
    })

    let webhookSubscribed = false
    let webhookError = ''
    try {
      const subscription = await subscribeAndVerifyWabaApps({
        accessToken,
        wabaId: config.wabaId,
        graphVersion,
      })
      webhookSubscribed = subscription.verified
      if (!subscription.verified) {
        webhookError = subscription.detail || errors.whatsappSubscribeFailed
      }
      await writeWhatsAppAudit({
        companyId: auth.companyId,
        actorUserId: auth.userId,
        action: whatsappAuditActions.wabaSubscribe,
        target: config.wabaId,
        outcome: subscription.verified
          ? whatsappAuditOutcomes.success
          : whatsappAuditOutcomes.failure,
        ip: meta.ip,
        requestId: meta.requestId,
        detail: subscription.detail,
      })
    } catch (error) {
      webhookError = sanitizeAuditDetail(error.message || 'WABA webhook subscription failed.')
      await writeWhatsAppAudit({
        companyId: auth.companyId,
        actorUserId: auth.userId,
        action: whatsappAuditActions.wabaSubscribe,
        target: config.wabaId,
        outcome: whatsappAuditOutcomes.failure,
        ip: meta.ip,
        requestId: meta.requestId,
        detail: webhookError,
      })
    }

    await releaseRegistrationLock(config, lockToken, {
      phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.registered,
      phoneRegisteredAt: new Date(),
      phoneRegistrationError: webhookError
        ? `Registered. Webhook subscription pending: ${webhookError}`.slice(0, 500)
        : '',
      wabaWebhookSubscribed: webhookSubscribed,
      wabaWebhookSubscribedAt: webhookSubscribed ? new Date() : null,
      updatedBy: auth.userId,
      lastError: '',
    })

    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.phoneRegister,
      target: config.phoneNumberId,
      outcome: whatsappAuditOutcomes.success,
      ip: meta.ip,
      requestId: meta.requestId,
      detail: 'Phone registered for Cloud API.',
    })

    const refreshed = await findCompanyConfig(auth)
    return {
      message: messages.whatsappPhoneRegistered,
      config: await presentWhatsAppConfigForApi(refreshed, auth.companyId),
    }
  } catch (error) {
    const detail = sanitizeAuditDetail(error.message || 'Registration failed.')
    await releaseRegistrationLock(config, lockToken, {
      phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.failed,
      phoneRegistrationError: detail.slice(0, 500),
      updatedBy: auth.userId,
    }).catch(() => {})
    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.phoneRegister,
      target: config.phoneNumberId || 'phone',
      outcome: whatsappAuditOutcomes.failure,
      ip: meta.ip,
      requestId: meta.requestId,
      detail,
    })
    if (error instanceof AppError) {
      throw error
    }
    throw new AppError(errors.whatsappRegistrationFailed, 502)
  } finally {
    accessToken = null
  }
}

/**
 * POST subscribed_apps then GET to confirm the platform app is listed.
 * Never marks success from POST alone.
 *
 * @param {{ accessToken: string, wabaId: string, graphVersion?: string }} params
 */
async function subscribeAndVerifyWabaApps({ accessToken, wabaId, graphVersion }) {
  if (!isWhatsAppWebhookConfigured()) {
    return {
      verified: false,
      detail: errors.whatsappWebhookNotConfigured,
    }
  }
  const platform = readWhatsAppEmbeddedSignupConfig()
  if (!platform.appId) {
    return {
      verified: false,
      detail: errors.whatsappWebhookNotConfigured,
    }
  }

  const posted = await subscribeWhatsAppWabaApps({
    accessToken,
    wabaId,
    graphVersion,
  })
  if (!posted.success) {
    return {
      verified: false,
      detail: errors.whatsappSubscribeFailed,
    }
  }

  const listed = await listWhatsAppWabaSubscribedApps({
    accessToken,
    wabaId,
    graphVersion,
  })
  const verified = listed.appIds.includes(String(platform.appId))
  return {
    verified,
    detail: verified
      ? 'WABA webhook subscription confirmed via subscribed_apps.'
      : 'Subscribe request succeeded but app was not listed on GET subscribed_apps.',
    appIds: listed.appIds,
  }
}

/**
 * Safe retry / reconciliation for WABA webhook subscription.
 *
 * @param {object} auth
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function reconcileWhatsAppWebhookSubscription(auth, meta = {}) {
  const config = await findCompanyConfig(auth)
  assertActiveConnection(config)
  if (!isWhatsAppWebhookConfigured()) {
    throw new AppError(errors.whatsappWebhookNotConfigured, 503)
  }

  let accessToken = null
  try {
    accessToken = readDecryptedAccessToken(config)
    const subscription = await subscribeAndVerifyWabaApps({
      accessToken,
      wabaId: config.wabaId,
      graphVersion: readWhatsAppGraphVersion(),
    })

    config.wabaWebhookSubscribed = subscription.verified
    config.wabaWebhookSubscribedAt = subscription.verified ? new Date() : null
    config.webhookLastError = subscription.verified
      ? ''
      : sanitizeAuditDetail(subscription.detail).slice(0, 500)
    config.updatedBy = auth.userId
    await config.save()

    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.wabaSubscribe,
      target: config.wabaId,
      outcome: subscription.verified
        ? whatsappAuditOutcomes.success
        : whatsappAuditOutcomes.failure,
      ip: meta.ip,
      requestId: meta.requestId,
      detail: subscription.detail,
    })

    if (!subscription.verified) {
      throw new AppError(errors.whatsappSubscribeFailed, 502)
    }

    return {
      message: messages.whatsappWebhookSubscribed,
      config: await presentWhatsAppConfigForApi(config, auth.companyId),
    }
  } finally {
    accessToken = null
  }
}

module.exports = {
  getRegistrationStatus,
  registerCompanyPhone,
  reconcileWhatsAppWebhookSubscription,
  subscribeAndVerifyWabaApps,
  assertActiveConnection,
  validatePin,
}
