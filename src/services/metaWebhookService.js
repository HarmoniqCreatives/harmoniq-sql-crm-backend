const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')
const { metaPageStatuses, metaWebhookIngestionStatuses } = require('../utils/enums')
const { messages } = require('../utils/messages')
const { decryptSecret } = require('../utils/metaSecrets')

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

function extractPageIdsFromRaw(rawBody) {
  const ids = new Set()
  let text = ''
  try {
    text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')
    const payload = JSON.parse(text)
    if (payload && Array.isArray(payload.entry)) {
      for (const entry of payload.entry) {
        if (entry && entry.id) ids.add(String(entry.id))
        if (entry && Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            if (change && change.value && change.value.page_id) {
              ids.add(String(change.value.page_id))
            }
          }
        }
      }
    }
  } catch {
    return []
  }
  return [...ids]
}

/**
 * Collects candidate App Secrets for signature verification.
 * Prefer secrets belonging to profiles that own the webhook's page IDs.
 */
async function readCandidateSecrets(rawBody) {
  const { MetaAppProfile, MetaPage } = getModels()
  const secrets = []
  const pageIds = extractPageIdsFromRaw(rawBody)

  if (process.env.META_APP_SECRET) {
    secrets.push(process.env.META_APP_SECRET)
  }

  let profileIds = null
  if (pageIds.length > 0) {
    const pages = await MetaPage.findAll({
      where: { pageId: pageIds },
      attributes: ['appProfileId', 'companyId'],
    })
    profileIds = [...new Set(pages.map((row) => row.appProfileId).filter(Boolean))]
  }

  const where = { secretStored: true, isActive: true }
  if (profileIds && profileIds.length > 0) {
    where.id = profileIds
  }

  const profiles = await MetaAppProfile.findAll({ where })
  for (const profile of profiles) {
    if (!profile.appSecretCipher) continue
    try {
      secrets.push(decryptSecret(profile.appSecretCipher))
    } catch {
      // Skip undecryptable secrets without failing the whole check.
    }
  }

  // If page-scoped profiles yielded nothing, fall back to all stored customer secrets.
  if (profileIds && profileIds.length > 0 && secrets.length <= (process.env.META_APP_SECRET ? 1 : 0)) {
    const all = await MetaAppProfile.findAll({ where: { secretStored: true, isActive: true } })
    for (const profile of all) {
      if (!profile.appSecretCipher) continue
      try {
        secrets.push(decryptSecret(profile.appSecretCipher))
      } catch {
        // ignore
      }
    }
  }

  return [...new Set(secrets)]
}

/**
 * Verifies X-Hub-Signature-256 against the exact raw body bytes.
 */
async function verifyWebhookSignature(rawBody, header) {
  if (!Buffer.isBuffer(rawBody)) return false
  if (!header || typeof header !== 'string') return false
  if (!header.startsWith('sha256=')) return false
  const secrets = await readCandidateSecrets(rawBody)
  for (const secret of secrets) {
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const expected = `sha256=${digest}`
    if (tokensMatch(header, expected)) {
      return true
    }
  }
  return false
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
 * Dedupe key matches manual Sync Now so webhook + sync races stay safe.
 */
async function acceptWebhookPayload(payload) {
  const { MetaPage } = getModels()
  const events = readLeadgenEvents(payload)
  for (const event of events) {
    const pages = await MetaPage.findAll({
      where: {
        pageId: event.pageId,
        status: metaPageStatuses.connected,
      },
    })
    if (pages.length === 0) {
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
    for (const page of pages) {
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
