const { getModels } = require('../models')
const {
  metaConnectionStatuses,
  metaEnrichmentStatuses,
} = require('../utils/enums')
const { decryptSecret } = require('../utils/metaSecrets')
const graphClient = require('./metaGraph')

/**
 * Meta advertising metadata enrichment + fill-empty-only Lead repair helpers.
 * Import success is independent of enrichment completeness.
 */

function createEnrichmentCache() {
  return new Map()
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

function fillIfEmpty(current, next) {
  if (!isBlank(current)) return String(current)
  if (!isBlank(next)) return String(next)
  return current ? String(current) : ''
}

function categorizeGraphError(errorCode) {
  const raw = String(errorCode || '').toLowerCase()
  if (!raw) return ''
  if (raw.includes('rate') || raw === '4' || raw === '17' || raw === '32' || raw === '613') {
    return 'rate_limit'
  }
  if (
    raw.includes('token')
    || raw.includes('expired')
    || raw === '190'
    || raw === '102'
    || raw === '463'
    || raw === '467'
  ) {
    return 'token'
  }
  if (
    raw.includes('permission')
    || raw.includes('(#10)')
    || raw === '10'
    || raw === '200'
    || raw === '294'
    || raw === '283'
  ) {
    return 'permission'
  }
  if (raw.includes('not found') || raw.includes('unsupported') || raw === '100') {
    return 'not_found'
  }
  if (raw.includes('network') || raw.includes('timeout') || raw.includes('fetch')) {
    return 'network'
  }
  if (raw.includes('empty') || raw === 'empty_campaign') {
    return 'empty'
  }
  return 'unknown'
}

function logEnrichmentEvent(event, fields) {
  console.log(JSON.stringify({
    event,
    companyId: fields.companyId || '',
    pageId: fields.pageId || '',
    leadgenId: fields.leadgenId || '',
    leadId: fields.leadId || '',
    objectType: fields.objectType || '',
    objectId: fields.objectId || '',
    errorCategory: fields.errorCategory || '',
    tokenKind: fields.tokenKind || '',
    message: fields.message ? String(fields.message).slice(0, 180) : '',
  }))
}

async function loadConnectionUserToken(page, companyId) {
  if (!page || !page.connectionId || !companyId) {
    return { userToken: '', granted: [] }
  }
  const { MetaConnection } = getModels()
  const connection = await MetaConnection.findOne({
    where: {
      id: page.connectionId,
      companyId,
      status: metaConnectionStatuses.connected,
    },
  })
  if (!connection || !connection.tokenCipher) {
    return { userToken: '', granted: [] }
  }
  let userToken = ''
  try {
    userToken = decryptSecret(connection.tokenCipher)
  } catch {
    return { userToken: '', granted: [] }
  }
  const granted = Array.isArray(connection.grantedPermissions)
    ? connection.grantedPermissions.map((item) => String(item))
    : []
  return { userToken, granted }
}

async function cachedLoad(cache, key, loader) {
  if (cache && cache.has(key)) {
    return cache.get(key)
  }
  const value = await loader()
  if (cache) cache.set(key, value)
  return value
}

async function enrichNamedObject({
  graph,
  objectType,
  objectId,
  pageToken,
  userToken,
  preferUser,
  purpose,
  cache,
  context,
}) {
  if (!objectId) {
    return { name: '', errorCategory: '' }
  }
  const client = graph || graphClient
  const readNamed = client.readNamedObject
    || (async (token, id, options) => {
      const name = client.readObjectName
        ? await client.readObjectName(token, id)
        : ''
      return { name: name || '', errorCode: name ? '' : 'EMPTY' }
    })

  return cachedLoad(cache, `${objectType}:${objectId}`, async () => {
    const order = preferUser && userToken
      ? [
        { token: userToken, kind: 'user' },
        { token: pageToken, kind: 'page' },
      ]
      : [
        { token: pageToken, kind: 'page' },
        { token: userToken, kind: 'user' },
      ]
    let lastCategory = 'empty'
    for (const attempt of order) {
      if (!attempt.token) continue
      const result = await readNamed(attempt.token, objectId, {
        fields: 'name',
        purpose: purpose || 'ads',
      })
      if (result && result.name) {
        return { name: String(result.name), errorCategory: '' }
      }
      lastCategory = categorizeGraphError(result && result.errorCode)
      logEnrichmentEvent('meta_enrichment_object_failed', {
        ...context,
        objectType,
        objectId,
        tokenKind: attempt.kind,
        errorCategory: lastCategory || 'empty',
      })
    }
    return { name: '', errorCategory: lastCategory || 'empty' }
  })
}

async function enrichCampaignObject({
  graph,
  campaignId,
  pageToken,
  userToken,
  cache,
  context,
}) {
  if (!campaignId) {
    return { name: '', effectiveStatus: '', errorCategory: '' }
  }
  const client = graph || graphClient
  if (!client.readCampaign) {
    const named = await enrichNamedObject({
      graph: client,
      objectType: 'campaign',
      objectId: campaignId,
      pageToken,
      userToken,
      preferUser: true,
      purpose: 'ads',
      cache,
      context,
    })
    return { name: named.name, effectiveStatus: '', errorCategory: named.errorCategory }
  }

  return cachedLoad(cache, `campaign:${campaignId}`, async () => {
    const order = []
    if (userToken) order.push({ token: userToken, kind: 'user' })
    if (pageToken) order.push({ token: pageToken, kind: 'page' })
    let lastCategory = 'empty'
    let name = ''
    let effectiveStatus = ''
    for (const attempt of order) {
      const result = await client.readCampaign(attempt.token, campaignId)
      if (result.name) name = String(result.name)
      if (result.effectiveStatus) effectiveStatus = String(result.effectiveStatus)
      if (name || effectiveStatus) {
        return { name, effectiveStatus, errorCategory: '' }
      }
      lastCategory = categorizeGraphError(result.errorCode) || 'empty'
      logEnrichmentEvent('meta_enrichment_object_failed', {
        ...context,
        objectType: 'campaign',
        objectId: campaignId,
        tokenKind: attempt.kind,
        errorCategory: lastCategory,
      })
    }
    return { name: '', effectiveStatus: '', errorCategory: lastCategory }
  })
}

/**
 * @param {{
 *   page: object,
 *   companyId: string,
 *   pageToken: string,
 *   ids: { campaignId?: string, adId?: string, adSetId?: string, formId?: string },
 *   graph?: object,
 *   cache?: Map,
 *   leadgenId?: string,
 *   leadId?: string,
 * }} args
 */
async function enrichMetaAdvertisingMetadata(args) {
  const page = args.page
  const companyId = args.companyId
  const pageToken = args.pageToken || ''
  const ids = args.ids || {}
  const graph = args.graph || graphClient
  const cache = args.cache || null
  const context = {
    companyId: companyId || '',
    pageId: page && page.pageId ? String(page.pageId) : '',
    leadgenId: args.leadgenId || '',
    leadId: args.leadId || '',
  }

  const { userToken } = await loadConnectionUserToken(page, companyId)

  const campaign = await enrichCampaignObject({
    graph,
    campaignId: ids.campaignId || '',
    pageToken,
    userToken,
    cache,
    context,
  })
  const ad = await enrichNamedObject({
    graph,
    objectType: 'ad',
    objectId: ids.adId || '',
    pageToken,
    userToken,
    preferUser: true,
    purpose: 'ads',
    cache,
    context,
  })
  const adSet = await enrichNamedObject({
    graph,
    objectType: 'adset',
    objectId: ids.adSetId || '',
    pageToken,
    userToken,
    preferUser: true,
    purpose: 'ads',
    cache,
    context,
  })
  const form = await enrichNamedObject({
    graph,
    objectType: 'form',
    objectId: ids.formId || '',
    pageToken,
    userToken,
    preferUser: false,
    purpose: 'forms',
    cache,
    context,
  })

  const wanted = []
  if (ids.campaignId) wanted.push({ key: 'campaign', got: Boolean(campaign.name || campaign.effectiveStatus), err: campaign.errorCategory })
  if (ids.adId) wanted.push({ key: 'ad', got: Boolean(ad.name), err: ad.errorCategory })
  if (ids.adSetId) wanted.push({ key: 'adset', got: Boolean(adSet.name), err: adSet.errorCategory })
  if (ids.formId) wanted.push({ key: 'form', got: Boolean(form.name), err: form.errorCategory })

  let status = metaEnrichmentStatuses.completed
  let errorCategory = ''
  if (wanted.length === 0) {
    status = metaEnrichmentStatuses.completed
  } else {
    const gotCount = wanted.filter((row) => row.got).length
    if (gotCount === wanted.length) {
      status = metaEnrichmentStatuses.completed
    } else if (gotCount === 0) {
      status = metaEnrichmentStatuses.failed
      errorCategory = wanted.map((row) => row.err).filter(Boolean)[0] || 'empty'
    } else {
      status = metaEnrichmentStatuses.partial
      errorCategory = wanted.filter((row) => !row.got).map((row) => row.err).filter(Boolean)[0] || 'partial'
    }
  }

  logEnrichmentEvent('meta_enrichment_result', {
    ...context,
    objectType: 'bundle',
    errorCategory: errorCategory || status,
    message: status,
  })

  return {
    campaignName: campaign.name || '',
    campaignStatus: campaign.effectiveStatus || '',
    adName: ad.name || '',
    adSetName: adSet.name || '',
    formName: form.name || '',
    metaEnrichmentStatus: status,
    metaEnrichmentError: errorCategory.slice(0, 80),
  }
}

/**
 * True when a Meta lead has blank structured advertising metadata that could still be filled.
 */
function leadNeedsMetaRepair(lead) {
  if (!lead || !lead.metaLeadId) return false
  if (lead.campaignId && (isBlank(lead.campaignName) || isBlank(lead.campaignStatus))) return true
  if (lead.adId && isBlank(lead.adName)) return true
  if (lead.adSetId && isBlank(lead.adSetName)) return true
  if (lead.formId && isBlank(lead.formName)) return true
  if (isBlank(lead.facebookPageId) || isBlank(lead.facebookPageName)) return true
  if (!lead.metaCreatedAt) return true
  return false
}

/**
 * Fill-empty-only patch. Never touches assignment, name, phone, email, or CRM enums.
 * @returns {{ changed: boolean, fields: string[] }}
 */
function buildFillEmptyMetadataPatch(lead, incoming) {
  const fields = []
  const patch = {}

  function consider(field, next) {
    const current = lead[field]
    const filled = fillIfEmpty(current, next)
    if (String(filled || '') !== String(current || '')) {
      patch[field] = filled
      fields.push(field)
    }
  }

  consider('campaignId', incoming.campaignId)
  consider('campaignName', incoming.campaignName)
  consider('campaignStatus', incoming.campaignStatus)
  consider('adId', incoming.adId)
  consider('adName', incoming.adName)
  consider('adSetId', incoming.adSetId)
  consider('adSetName', incoming.adSetName)
  consider('formId', incoming.formId)
  consider('formName', incoming.formName)
  consider('facebookPageId', incoming.facebookPageId)
  consider('facebookPageName', incoming.facebookPageName)

  if (!lead.metaCreatedAt && incoming.metaCreatedAt) {
    patch.metaCreatedAt = incoming.metaCreatedAt
    fields.push('metaCreatedAt')
  }

  if (incoming.metaEnrichmentStatus) {
    const nextStatus = String(incoming.metaEnrichmentStatus)
    if (nextStatus !== String(lead.metaEnrichmentStatus || '')) {
      patch.metaEnrichmentStatus = nextStatus
      fields.push('metaEnrichmentStatus')
    }
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'metaEnrichmentError')) {
    const nextError = String(incoming.metaEnrichmentError || '').slice(0, 80)
    if (nextError !== String(lead.metaEnrichmentError || '')) {
      patch.metaEnrichmentError = nextError
      fields.push('metaEnrichmentError')
    }
  }

  return { changed: fields.length > 0, fields, patch }
}

/**
 * Apply fill-empty metadata to an existing company-scoped Lead.
 */
async function applyMetaMetadataToLead(lead, incoming) {
  const { changed, fields, patch } = buildFillEmptyMetadataPatch(lead, incoming)
  if (!changed) {
    return { changed: false, fields: [] }
  }
  Object.assign(lead, patch)
  await lead.save()
  return { changed: true, fields }
}

module.exports = {
  createEnrichmentCache,
  enrichMetaAdvertisingMetadata,
  leadNeedsMetaRepair,
  buildFillEmptyMetadataPatch,
  applyMetaMetadataToLead,
  fillIfEmpty,
  isBlank,
  categorizeGraphError,
  metaEnrichmentStatuses,
  logEnrichmentEvent,
}
