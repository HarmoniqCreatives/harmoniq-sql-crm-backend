const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')
const {
  whatsappMessageStatuses,
  whatsappOutboxStatuses,
} = require('../utils/enums')
const { isWhatsAppWebhookConfigured } = require('../config/whatsappEnv')
const { messages } = require('../utils/messages')
const { sanitizeAuditDetail } = require('./whatsappAuditService')

const STATUS_RANK = {
  [whatsappMessageStatuses.queued]: 0,
  [whatsappMessageStatuses.sent]: 1,
  [whatsappMessageStatuses.delivered]: 2,
  [whatsappMessageStatuses.read]: 3,
  [whatsappMessageStatuses.failed]: 50,
  [whatsappMessageStatuses.cancelled]: 50,
  [whatsappMessageStatuses.skipped]: 50,
}

const TERMINAL_STATUSES = new Set([
  whatsappMessageStatuses.failed,
  whatsappMessageStatuses.cancelled,
  whatsappMessageStatuses.skipped,
])

function tokensMatch(left, right) {
  const actual = Buffer.from(String(left))
  const expected = Buffer.from(String(right))
  if (actual.length !== expected.length) {
    return false
  }
  return crypto.timingSafeEqual(actual, expected)
}

function readHubValue(query, name) {
  if (!query) return ''
  const flat = query[`hub.${name}`]
  if (typeof flat === 'string') return flat
  if (query.hub && typeof query.hub === 'object' && typeof query.hub[name] === 'string') {
    return query.hub[name]
  }
  return ''
}

/**
 * Validates WhatsApp webhook verification challenge.
 * @returns {string} challenge plain text, or empty string when rejected
 */
function verifyWhatsAppWebhookChallenge(query) {
  const mode = readHubValue(query, 'mode')
  const token = readHubValue(query, 'verify_token')
  const challenge = readHubValue(query, 'challenge')
  const expected = String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim()
  if (mode !== messages.whatsappWebhookMode) return ''
  if (!expected) return ''
  if (!tokensMatch(token, expected)) return ''
  return challenge
}

/**
 * Verifies X-Hub-Signature-256 using WHATSAPP_APP_SECRET and raw body bytes.
 */
function verifyWhatsAppWebhookSignature(rawBody, header) {
  if (!Buffer.isBuffer(rawBody)) return false
  if (!header || typeof header !== 'string') return false
  if (!header.startsWith('sha256=')) return false
  const secret = String(process.env.WHATSAPP_APP_SECRET || '').trim()
  if (!secret) return false
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const expected = `sha256=${digest}`
  return tokensMatch(header, expected)
}

function digestPayload(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex')
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'played') {
    return whatsappMessageStatuses.read
  }
  if (Object.values(whatsappMessageStatuses).includes(status)) {
    return status
  }
  return ''
}

function canAdvanceStatus(current, next) {
  if (!next) return false
  if (!current || current === whatsappMessageStatuses.queued) {
    return true
  }
  if (TERMINAL_STATUSES.has(current)) {
    return false
  }
  if (next === whatsappMessageStatuses.failed) {
    return current === whatsappMessageStatuses.sent
      || current === whatsappMessageStatuses.delivered
      || current === whatsappMessageStatuses.queued
  }
  const currentRank = STATUS_RANK[current]
  const nextRank = STATUS_RANK[next]
  if (currentRank === undefined || nextRank === undefined) {
    return false
  }
  return nextRank > currentRank
}

function readStatusError(statusRow) {
  if (!statusRow || !Array.isArray(statusRow.errors) || statusRow.errors.length === 0) {
    return ''
  }
  const first = statusRow.errors[0] || {}
  const parts = [
    first.code ? `code=${first.code}` : '',
    first.title || first.message || '',
  ].filter(Boolean)
  return sanitizeAuditDetail(parts.join(' ')).slice(0, 500)
}

function extractWhatsAppWebhookItems(payload) {
  const items = []
  if (!payload || payload.object !== messages.whatsappWebhookObject || !Array.isArray(payload.entry)) {
    return items
  }
  for (const entry of payload.entry) {
    const wabaId = entry && entry.id ? String(entry.id) : ''
    if (!Array.isArray(entry.changes)) continue
    for (const change of entry.changes) {
      if (!change || !change.field) continue
      const field = String(change.field)
      const value = change.value || {}
      const phoneNumberId = value.metadata && value.metadata.phone_number_id
        ? String(value.metadata.phone_number_id)
        : ''
      if (field === 'messages' && Array.isArray(value.statuses)) {
        for (const statusRow of value.statuses) {
          if (!statusRow || !statusRow.id || !statusRow.status) continue
          items.push({
            kind: 'status',
            wabaId,
            phoneNumberId,
            providerMessageId: String(statusRow.id),
            status: normalizeStatus(statusRow.status),
            timestamp: statusRow.timestamp ? String(statusRow.timestamp) : '',
            errorDetail: readStatusError(statusRow),
            rawStatus: String(statusRow.status),
          })
        }
      } else {
        items.push({
          kind: 'other',
          wabaId,
          phoneNumberId,
          field,
          providerMessageId: null,
          status: '',
          timestamp: '',
          errorDetail: '',
        })
      }
    }
  }
  return items
}

async function resolveCompanyConfig({ wabaId, phoneNumberId }) {
  const { WhatsAppCompanyConfig } = getModels()
  if (phoneNumberId) {
    const byPhone = await WhatsAppCompanyConfig.findOne({
      where: { phoneNumberId, isActive: true },
    })
    if (byPhone) return byPhone
  }
  if (wabaId) {
    const byWaba = await WhatsAppCompanyConfig.findOne({
      where: { wabaId, isActive: true },
    })
    if (byWaba) return byWaba
  }
  return null
}

async function insertWebhookEventOnce(fields) {
  const { WhatsAppWebhookEvent } = getModels()
  try {
    await WhatsAppWebhookEvent.create(fields)
    return { inserted: true }
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return { inserted: false }
    }
    throw error
  }
}

function buildDedupeKey(item, payloadDigest) {
  if (item.kind === 'status') {
    return `wa:${item.wabaId}:${item.phoneNumberId}:${item.providerMessageId}:${item.status}:${item.timestamp}`
      .slice(0, 191)
  }
  const digestPart = payloadDigest ? String(payloadDigest).slice(0, 16) : uuidv4().slice(0, 8)
  return `wa:${item.wabaId}:${item.phoneNumberId}:${item.field}:${digestPart}`
    .slice(0, 191)
}

function historyHasEvent(events, status, timestamp) {
  if (!Array.isArray(events)) return false
  return events.some((row) => (
    row
    && String(row.status || '') === String(status)
    && String(row.providerTimestamp || row.timestamp || '') === String(timestamp || '')
  ))
}

async function applyStatusUpdate(config, item) {
  const { WhatsAppMessageLog, WhatsAppOutbox, WhatsAppCompanyConfig } = getModels()
  if (!item.status) {
    return 'ignored_unsupported_status'
  }

  const log = await WhatsAppMessageLog.findOne({
    where: {
      companyId: config.companyId,
      providerMessageId: item.providerMessageId,
    },
  })
  if (!log) {
    return 'ignored_unknown_message'
  }

  const events = Array.isArray(log.statusEvents) ? [...log.statusEvents] : []
  const alreadyRecorded = historyHasEvent(events, item.status, item.timestamp)
  if (!alreadyRecorded) {
    events.push({
      at: new Date().toISOString(),
      status: item.status,
      providerTimestamp: item.timestamp || null,
      source: 'webhook',
      error: item.errorDetail || undefined,
    })
  }

  const shouldAdvance = canAdvanceStatus(log.status, item.status)
  if (shouldAdvance) {
    log.status = item.status
    if (item.errorDetail) {
      log.lastError = item.errorDetail
    } else if (item.status !== whatsappMessageStatuses.failed) {
      log.lastError = ''
    }
  }
  log.statusEvents = events
  await log.save()

  if (log.outboxId && shouldAdvance) {
    const outboxPatch = {}
    if (item.status === whatsappMessageStatuses.sent) {
      outboxPatch.status = whatsappOutboxStatuses.sent
      outboxPatch.providerMessageId = item.providerMessageId
      outboxPatch.lastError = ''
    } else if (item.status === whatsappMessageStatuses.failed) {
      outboxPatch.status = whatsappOutboxStatuses.failed
      outboxPatch.lastError = item.errorDetail || 'Provider reported failure.'
    } else if (
      item.status === whatsappMessageStatuses.delivered
      || item.status === whatsappMessageStatuses.read
    ) {
      outboxPatch.providerMessageId = item.providerMessageId
      outboxPatch.lastError = ''
    }
    if (Object.keys(outboxPatch).length > 0) {
      await WhatsAppOutbox.update(outboxPatch, {
        where: {
          id: log.outboxId,
          companyId: config.companyId,
        },
      })
    }
  }

  await WhatsAppCompanyConfig.update({
    webhookLastEventAt: new Date(),
    webhookLastError: '',
  }, {
    where: { id: config.id, companyId: config.companyId },
  })

  if (alreadyRecorded && !shouldAdvance) {
    return 'duplicate_status'
  }
  if (!shouldAdvance) {
    return 'ignored_stale_status'
  }
  return 'updated'
}

/**
 * Accepts a verified WhatsApp webhook payload. Idempotent per dedupeKey.
 *
 * @param {object} payload
 * @param {Buffer} [rawBody]
 */
async function acceptWhatsAppWebhookPayload(payload, rawBody) {
  const payloadDigest = Buffer.isBuffer(rawBody) ? digestPayload(rawBody) : null
  const items = extractWhatsAppWebhookItems(payload)
  let processed = 0
  let duplicates = 0
  let ignored = 0

  if (items.length === 0) {
    await insertWebhookEventOnce({
      id: uuidv4(),
      companyId: null,
      dedupeKey: `wa:unsupported:${payloadDigest || uuidv4()}`.slice(0, 191),
      providerMessageId: null,
      eventType: 'unsupported',
      payloadDigest,
      processedAt: new Date(),
      outcome: 'ignored_unsupported',
    })
    return { processed, duplicates, ignored: 1 }
  }

  for (const item of items) {
    const config = await resolveCompanyConfig({
      wabaId: item.wabaId,
      phoneNumberId: item.phoneNumberId,
    })
    const companyId = config ? config.companyId : null
    const dedupeKey = buildDedupeKey(item, payloadDigest)
    const eventType = item.kind === 'status' ? `status:${item.status}` : String(item.field || 'other')

    const insert = await insertWebhookEventOnce({
      id: uuidv4(),
      companyId,
      dedupeKey,
      providerMessageId: item.providerMessageId,
      eventType,
      payloadDigest,
      processedAt: null,
      outcome: 'received',
    })
    if (!insert.inserted) {
      duplicates += 1
      continue
    }

    if (!config) {
      const { WhatsAppWebhookEvent } = getModels()
      await WhatsAppWebhookEvent.update({
        processedAt: new Date(),
        outcome: 'ignored_unknown_company',
      }, { where: { dedupeKey } })
      ignored += 1
      continue
    }

    let outcome = 'ignored'
    try {
      if (item.kind === 'status') {
        outcome = await applyStatusUpdate(config, item)
      } else {
        outcome = 'ignored_unsupported_field'
        await getModels().WhatsAppCompanyConfig.update({
          webhookLastEventAt: new Date(),
        }, { where: { id: config.id, companyId: config.companyId } })
      }
    } catch (error) {
      outcome = 'failed'
      await getModels().WhatsAppCompanyConfig.update({
        webhookLastError: sanitizeAuditDetail(error.message || 'Webhook processing failed').slice(0, 500),
      }, { where: { id: config.id, companyId: config.companyId } })
    }

    await getModels().WhatsAppWebhookEvent.update({
      processedAt: new Date(),
      outcome,
    }, {
      where: {
        dedupeKey,
        companyId,
      },
    })

    if (outcome === 'updated') processed += 1
    else if (outcome === 'duplicate_status') duplicates += 1
    else ignored += 1
  }

  return { processed, duplicates, ignored }
}

module.exports = {
  STATUS_RANK,
  canAdvanceStatus,
  isWhatsAppWebhookConfigured,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  extractWhatsAppWebhookItems,
  acceptWhatsAppWebhookPayload,
  historyHasEvent,
}
