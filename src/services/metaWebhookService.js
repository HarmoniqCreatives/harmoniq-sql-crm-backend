const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')
const { metaWebhookIngestionStatuses } = require('../utils/enums')
const { messages } = require('../utils/messages')
const { findCanonicalConnectedPage } = require('./metaPageOwnership')

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
 * Validates Meta webhook verification challenge with constant-time token compare.
 * @returns {string} challenge plain text, or empty string when rejected
 */
function verifyWebhookChallenge(query) {
  const mode = readHubValue(query, 'mode')
  const token = readHubValue(query, 'verify_token')
  const challenge = readHubValue(query, 'challenge')
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN
  if (mode !== messages.metaWebhookMode) return ''
  if (!expected) return ''
  if (!tokensMatch(token, expected)) return ''
  return challenge
}

/**
 * Verifies X-Hub-Signature-256 against the exact raw body bytes.
 * Uses ONLY the central Meta Developer App Secret (META_APP_SECRET).
 * Never uses company/customer App Secrets for webhook HMAC.
 */
function verifyWebhookSignature(rawBody, header) {
  if (!Buffer.isBuffer(rawBody)) return false
  if (!header || typeof header !== 'string') return false
  if (!header.startsWith('sha256=')) return false

  const secret = process.env.META_APP_SECRET
  if (!secret || typeof secret !== 'string' || !secret.trim()) {
    console.error(JSON.stringify({
      event: 'meta_webhook_signature_misconfigured',
      reason: 'META_APP_SECRET_missing',
    }))
    return false
  }

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const expected = `sha256=${digest}`
  return tokensMatch(header, expected)
}

function readLeadgenEvents(payload) {
  const events = []
  if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)) {
    return events
  }
  for (const entry of payload.entry) {
    if (!Array.isArray(entry.changes)) continue
    for (const change of entry.changes) {
      if (!change || change.field !== messages.metaLeadgenField || !change.value) continue
      let pageId = change.value.page_id ? String(change.value.page_id) : ''
      if (!pageId && entry.id) pageId = String(entry.id)
      const leadgenId = change.value.leadgen_id ? String(change.value.leadgen_id) : ''
      if (!pageId || !leadgenId) continue
      const formId = change.value.form_id ? String(change.value.form_id) : ''
      events.push({ pageId, leadgenId, formId })
    }
  }
  return events
}

function buildDedupeKey(companyId, pageId, leadgenId) {
  return `${companyId}:${pageId}:${leadgenId}`
}

/** Dedupe key for unknown-page noise — never scoped to a company. */
function buildIgnoredDedupeKey(pageId, leadgenId) {
  return `ignored:${pageId}:${leadgenId}`
}

/**
 * Inserts one ingestion row; duplicate unique keys are treated as success.
 */
async function insertIngestionOnce(fields) {
  const { MetaWebhookIngestion } = getModels()
  try {
    await MetaWebhookIngestion.create(fields)
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return
    }
    throw error
  }
}

/**
 * Persists signed leadgen events. Connected Pages → status `pending` (worker imports).
 * Unknown Pages → status `ignored` with null companyId (no Graph / no lead create).
 * Routes only to the canonical connected Page owner (oldest row if duplicates remain).
 * Dedupe key matches manual Sync Now so webhook + sync races stay safe.
 */
async function acceptWebhookPayload(payload) {
  const { MetaPage } = getModels()
  const events = readLeadgenEvents(payload)
  for (const event of events) {
    const page = await findCanonicalConnectedPage(MetaPage, event.pageId)
    if (!page) {
      await insertIngestionOnce({
        id: uuidv4(),
        companyId: null,
        metaPageId: null,
        connectionId: null,
        pageId: event.pageId,
        leadgenId: event.leadgenId,
        formId: event.formId,
        dedupeKey: buildIgnoredDedupeKey(event.pageId, event.leadgenId),
        status: metaWebhookIngestionStatuses.ignored,
      })
      continue
    }
    await insertIngestionOnce({
      id: uuidv4(),
      companyId: page.companyId,
      metaPageId: page.id,
      connectionId: page.connectionId,
      pageId: event.pageId,
      leadgenId: event.leadgenId,
      formId: event.formId,
      dedupeKey: buildDedupeKey(page.companyId, event.pageId, event.leadgenId),
      status: metaWebhookIngestionStatuses.pending,
    })
  }
}

module.exports = {
  acceptWebhookPayload,
  buildDedupeKey,
  buildIgnoredDedupeKey,
  readLeadgenEvents,
  tokensMatch,
  verifyWebhookChallenge,
  verifyWebhookSignature,
}
