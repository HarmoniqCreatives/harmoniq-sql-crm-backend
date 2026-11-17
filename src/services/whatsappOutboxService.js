const crypto = require('crypto')
const os = require('os')
const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { security } = require('../config/security')
const { readWhatsAppGraphVersion } = require('../config/whatsappEnv')
const { getModels } = require('../models')
const {
  whatsappAuditActions,
  whatsappAuditOutcomes,
  whatsappMessageStatuses,
  whatsappOutboxStatuses,
  whatsappPhoneRegistrationStatuses,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const { sendWhatsAppTemplateMessage } = require('./whatsappCloudClient')
const { writeWhatsAppAudit, sanitizeAuditDetail } = require('./whatsappAuditService')
const {
  findCompanyConfig,
  readDecryptedAccessToken,
} = require('./whatsappConfigService')
const { assertActiveConnection } = require('./whatsappRegistrationService')

const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`

let pollTimer = null
let tickInFlight = false

function readPollMs() {
  const raw = Number(security.whatsappOutboxPollMs)
  return Number.isFinite(raw) && raw >= 1000 ? raw : 3000
}

function readLeaseMs() {
  const raw = Number(security.whatsappOutboxLeaseMs)
  return Number.isFinite(raw) && raw >= 5000 ? raw : 60_000
}

function readBatchSize() {
  const raw = Number(security.whatsappOutboxBatchSize)
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 10
}

function readMaxAttempts() {
  const raw = Number(security.whatsappOutboxMaxAttempts)
  return Number.isFinite(raw) && raw > 0 ? raw : 5
}

function normalizeRecipientPhone(value) {
  const text = String(value || '').trim().replace(/[\s-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(text)) {
    throw new AppError(errors.whatsappRecipientInvalid, 400)
  }
  return text
}

function computeBackoffMs(attempts) {
  const base = 15_000
  const capped = Math.min(30 * 60 * 1000, base * (2 ** Math.max(0, attempts - 1)))
  const jitter = Math.floor(Math.random() * 2000)
  return capped + jitter
}

/**
 * Ensures company can send: connected, registered, token usable, approved template.
 *
 * @param {object} auth
 * @param {{
 *   templateId?: string,
 *   templateName?: string,
 *   language?: string,
 *   parameters?: string[],
 *   workflowKey?: string,
 * }} details
 */
async function assertSendEligibility(auth, details = {}) {
  const config = await findCompanyConfig(auth)
  assertActiveConnection(config)
  if (config.phoneRegistrationStatus !== whatsappPhoneRegistrationStatuses.registered) {
    throw new AppError(errors.whatsappPhoneNotRegistered, 400)
  }

  const { WhatsAppTemplate } = getModels()
  const where = {
    companyId: auth.companyId,
    wabaId: config.wabaId,
    isEnabled: true,
    status: messages.whatsappApprovedTemplateStatus,
  }
  if (details.templateId) {
    where.id = details.templateId
  } else if (details.templateName) {
    where.name = details.templateName
    if (details.language) {
      where.language = details.language
    }
  } else {
    throw new AppError(errors.whatsappTemplateUnavailable, 400)
  }

  const template = await WhatsAppTemplate.findOne({ where })
  if (!template) {
    throw new AppError(errors.whatsappSendUnavailable, 400)
  }

  const expectedKeys = Array.isArray(template.bodyVariableKeys) ? template.bodyVariableKeys : []
  const parameters = Array.isArray(details.parameters) ? details.parameters.map((item) => String(item)) : []
  if (parameters.length !== expectedKeys.length) {
    throw new AppError(errors.whatsappTemplateParamsInvalid, 400)
  }

  return { config, template, parameters }
}

/**
 * Enqueues one template message with company-scoped idempotency.
 *
 * @param {object} auth
 * @param {object} body
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function enqueueWhatsAppMessage(auth, body, meta = {}) {
  const recipientPhone = normalizeRecipientPhone(body?.recipientPhone || body?.to)
  const idempotencyKey = String(body?.idempotencyKey || '').trim()
  if (!idempotencyKey || idempotencyKey.length > 191) {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }

  const { config, template, parameters } = await assertSendEligibility(auth, {
    templateId: body?.templateId,
    templateName: body?.templateName,
    language: body?.language,
    parameters: body?.parameters || body?.templateParameters,
    workflowKey: body?.workflowKey,
  })

  const { sequelize, WhatsAppMessageLog, WhatsAppOutbox } = getModels()
  const messageLogId = uuidv4()
  const outboxId = uuidv4()
  const workflowKey = String(body?.workflowKey || '').trim()
  const recipientType = String(body?.recipientType || 'manual').trim().slice(0, 32) || 'manual'

  try {
    await sequelize.transaction(async (transaction) => {
      await WhatsAppMessageLog.create({
        id: messageLogId,
        companyId: auth.companyId,
        outboxId,
        recipientPhone,
        recipientType,
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        workflowKey,
        status: whatsappMessageStatuses.queued,
        idempotencyKey,
        statusEvents: [{ at: new Date().toISOString(), status: 'queued' }],
      }, { transaction })

      await WhatsAppOutbox.create({
        id: outboxId,
        companyId: auth.companyId,
        messageLogId,
        recipientPhone,
        recipientType,
        templateName: template.name,
        language: template.language,
        templateParameters: parameters,
        status: whatsappOutboxStatuses.queued,
        attempts: 0,
        maxAttempts: readMaxAttempts(),
        nextAttemptAt: new Date(),
        idempotencyKey,
        workflowKey,
      }, { transaction })
    })
  } catch (error) {
    if (error && (error.name === 'SequelizeUniqueConstraintError' || error.parent?.code === 'ER_DUP_ENTRY')) {
      throw new AppError(errors.whatsappIdempotencyConflict, 409)
    }
    throw error
  }

  await writeWhatsAppAudit({
    companyId: auth.companyId,
    actorUserId: auth.userId,
    action: whatsappAuditActions.messageEnqueue,
    target: outboxId,
    outcome: whatsappAuditOutcomes.success,
    ip: meta.ip,
    requestId: meta.requestId,
    detail: sanitizeAuditDetail(JSON.stringify({
      templateName: template.name,
      language: template.language,
      phoneNumberId: config.phoneNumberId,
      workflowKey,
    })),
  })

  return {
    message: messages.whatsappMessageQueued,
    outboxId,
    messageLogId,
    idempotencyKey,
  }
}

/**
 * Claims due outbox rows using row locks. Prefers SKIP LOCKED on MySQL 8.4.
 * Falls back to conditional lock-token updates if skipLocked is unavailable.
 *
 * Production worker calls claimOutboxJobs() with no filters.
 * Optional filters (companyId / outboxId) isolate tests from leftover queued rows
 * in a shared DB without changing default worker behavior.
 *
 * @param {number} [limit]
 * @param {{ companyId?: string, outboxId?: string }} [options]
 * @returns {Promise<object[]>}
 */
async function claimOutboxJobs(limit = readBatchSize(), options = {}) {
  const { sequelize, WhatsAppOutbox } = getModels()
  const now = new Date()
  const leaseMs = readLeaseMs()
  const claimed = []
  const scope = {}
  if (options && options.companyId) {
    scope.companyId = options.companyId
  }
  if (options && options.outboxId) {
    scope.id = options.outboxId
  }

  await sequelize.transaction(async (transaction) => {
    let rows = []
    try {
      rows = await WhatsAppOutbox.findAll({
        where: {
          ...scope,
          status: {
            [Op.in]: [whatsappOutboxStatuses.queued, whatsappOutboxStatuses.processing],
          },
          nextAttemptAt: { [Op.lte]: now },
          [Op.or]: [
            { status: whatsappOutboxStatuses.queued },
            {
              status: whatsappOutboxStatuses.processing,
              [Op.or]: [
                { lockExpiresAt: null },
                { lockExpiresAt: { [Op.lte]: now } },
              ],
            },
          ],
        },
        order: [['nextAttemptAt', 'ASC']],
        limit,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
        transaction,
      })
    } catch {
      rows = await WhatsAppOutbox.findAll({
        where: {
          ...scope,
          status: whatsappOutboxStatuses.queued,
          nextAttemptAt: { [Op.lte]: now },
        },
        order: [['nextAttemptAt', 'ASC']],
        limit,
        lock: transaction.LOCK.UPDATE,
        transaction,
      })
    }

    for (const row of rows) {
      const lockToken = uuidv4()
      const lockExpiresAt = new Date(Date.now() + leaseMs)
      const [updated] = await WhatsAppOutbox.update({
        status: whatsappOutboxStatuses.processing,
        lockedAt: now,
        lockedBy: WORKER_ID,
        lockExpiresAt,
        lockToken,
        attempts: row.attempts + 1,
      }, {
        where: {
          id: row.id,
          companyId: row.companyId,
          [Op.or]: [
            { status: whatsappOutboxStatuses.queued },
            {
              status: whatsappOutboxStatuses.processing,
              [Op.or]: [
                { lockExpiresAt: null },
                { lockExpiresAt: { [Op.lte]: now } },
              ],
            },
          ],
        },
        transaction,
      })
      if (!updated) {
        continue
      }
      await row.reload({ transaction })
      claimed.push(row)
    }
  })

  return claimed
}

async function finalizeOutboxSuccess(job, providerMessageId) {
  const { WhatsAppOutbox, WhatsAppMessageLog } = getModels()
  const [updated] = await WhatsAppOutbox.update({
    status: whatsappOutboxStatuses.sent,
    providerMessageId,
    lastError: '',
    lockedAt: null,
    lockedBy: null,
    lockExpiresAt: null,
    lockToken: null,
  }, {
    where: {
      id: job.id,
      companyId: job.companyId,
      lockToken: job.lockToken,
      status: whatsappOutboxStatuses.processing,
    },
  })
  if (!updated) {
    return false
  }
  const log = await WhatsAppMessageLog.findByPk(job.messageLogId)
  if (log && log.companyId === job.companyId) {
    const events = Array.isArray(log.statusEvents) ? [...log.statusEvents] : []
    events.push({ at: new Date().toISOString(), status: 'sent', providerMessageId })
    log.status = whatsappMessageStatuses.sent
    log.providerMessageId = providerMessageId
    log.outboxId = job.id
    log.lastError = ''
    log.statusEvents = events
    await log.save()
  }
  return true
}

async function finalizeOutboxFailure(job, error, { permanent = false } = {}) {
  const { WhatsAppOutbox, WhatsAppMessageLog } = getModels()
  const graphCode = error instanceof AppError && error.details && error.details.graphCode
    ? `graphCode=${error.details.graphCode}`
    : ''
  const errorCode = error instanceof AppError && error.code ? String(error.code) : ''
  const detail = sanitizeAuditDetail(
    [errorCode, graphCode, error && error.message ? error.message : 'Send failed']
      .filter(Boolean)
      .join(' | '),
  ).slice(0, 500)
  const attempts = job.attempts
  const maxAttempts = job.maxAttempts || readMaxAttempts()
  const retryable = !permanent
    && !(error instanceof AppError && error.details && error.details.retryable === false)
    && !(error instanceof AppError && error.details && error.details.ambiguous)
    && attempts < maxAttempts

  const patch = {
    lastError: detail,
    lockedAt: null,
    lockedBy: null,
    lockExpiresAt: null,
    lockToken: null,
  }
  if (retryable) {
    patch.status = whatsappOutboxStatuses.queued
    patch.nextAttemptAt = new Date(Date.now() + computeBackoffMs(attempts))
  } else {
    patch.status = whatsappOutboxStatuses.failed
  }

  const [updated] = await WhatsAppOutbox.update(patch, {
    where: {
      id: job.id,
      companyId: job.companyId,
      lockToken: job.lockToken,
      status: whatsappOutboxStatuses.processing,
    },
  })
  if (!updated) {
    return false
  }

  if (!retryable) {
    const log = await WhatsAppMessageLog.findByPk(job.messageLogId)
    if (log && log.companyId === job.companyId) {
      const events = Array.isArray(log.statusEvents) ? [...log.statusEvents] : []
      events.push({ at: new Date().toISOString(), status: 'failed', error: detail })
      log.status = whatsappMessageStatuses.failed
      log.lastError = detail
      log.statusEvents = events
      await log.save()
    }
  }
  return true
}

/**
 * Processes one claimed job. Never holds a DB transaction during Meta HTTP.
 *
 * @param {object} job
 */
async function processOutboxJob(job) {
  const auth = { companyId: job.companyId, userId: null }
  let accessToken = null
  try {
    const { config, parameters } = await assertSendEligibility(auth, {
      templateName: job.templateName,
      language: job.language,
      parameters: Array.isArray(job.templateParameters) ? job.templateParameters : [],
    })
    accessToken = readDecryptedAccessToken(config)
    const result = await sendWhatsAppTemplateMessage({
      accessToken,
      phoneNumberId: config.phoneNumberId,
      to: job.recipientPhone.replace(/^\+/, ''),
      templateName: job.templateName,
      language: job.language,
      bodyParameters: parameters,
      graphVersion: readWhatsAppGraphVersion(),
    })
    await finalizeOutboxSuccess(job, result.providerMessageId)
  } catch (error) {
    const permanent = Boolean(
      error instanceof AppError
      && (error.details?.ambiguous || error.details?.retryable === false),
    )
    await finalizeOutboxFailure(job, error, { permanent })
  } finally {
    accessToken = null
  }
}

async function runWhatsAppOutboxTick() {
  if (tickInFlight) {
    return
  }
  tickInFlight = true
  try {
    const jobs = await claimOutboxJobs()
    for (const job of jobs) {
      await processOutboxJob(job)
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: 'whatsapp_outbox_tick_failed',
      message: sanitizeAuditDetail(error.message || 'tick failed'),
    }))
  } finally {
    tickInFlight = false
  }
}

function startWhatsAppOutboxWorker() {
  if (process.env.WHATSAPP_OUTBOX_AUTORUN === '0') {
    return
  }
  if (process.env.NODE_ENV === 'test' && process.env.WHATSAPP_OUTBOX_AUTORUN !== '1') {
    return
  }
  if (pollTimer) {
    return
  }
  const pollMs = readPollMs()
  pollTimer = setInterval(() => {
    runWhatsAppOutboxTick().catch(() => {})
  }, pollMs)
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref()
  }
  runWhatsAppOutboxTick().catch(() => {})
}

function stopWhatsAppOutboxWorker() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

module.exports = {
  WORKER_ID,
  enqueueWhatsAppMessage,
  assertSendEligibility,
  claimOutboxJobs,
  processOutboxJob,
  runWhatsAppOutboxTick,
  startWhatsAppOutboxWorker,
  stopWhatsAppOutboxWorker,
  finalizeOutboxSuccess,
  finalizeOutboxFailure,
}
