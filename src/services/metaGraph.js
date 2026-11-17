const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const { security } = require('../config/security')

/** @type {typeof fetch} */
let fetchImpl = globalThis.fetch.bind(globalThis)

/**
 * Allows tests to mock Graph HTTP without hitting Facebook.
 * @param {typeof fetch} impl
 */
function setFetchImpl(impl) {
  fetchImpl = impl
}

function resetFetchImpl() {
  fetchImpl = globalThis.fetch.bind(globalThis)
}

function readGraphVersion() {
  return process.env.META_GRAPH_API_VERSION
    || process.env.META_GRAPH_VERSION
    || messages.defaultGraphVersion
}

/**
 * Maps Graph error codes to safe AppErrors without leaking tokens.
 * @param {object|null} payload
 * @param {number} httpStatus
 * @param {{ purpose?: string }} [options]
 */
function throwMappedGraphError(payload, httpStatus, options = {}) {
  let graphCode = 0
  let graphMessage = ''
  if (payload && payload.error) {
    if (typeof payload.error.code === 'number') {
      graphCode = payload.error.code
    }
    if (typeof payload.error.message === 'string') {
      graphMessage = payload.error.message.toLowerCase()
    }
  }
  const purpose = options.purpose || ''
  if (graphCode === 190 || graphCode === 102 || graphCode === 463 || graphCode === 467) {
    throw new AppError(
      graphCode === 102 ? errors.metaTokenInvalid : errors.metaTokenExpired,
      401,
      'META_TOKEN_EXPIRED',
      { action: 'RECONNECT' },
    )
  }
  if (graphCode === 4 || graphCode === 17 || graphCode === 32 || graphCode === 613) {
    throw new AppError(errors.metaRateLimited, 429, 'META_RATE_LIMITED')
  }
  if (graphCode === 10 || graphCode === 200 || graphCode === 294 || graphCode === 283) {
    if (purpose === 'forms' || graphMessage.includes('leads_retrieval') || graphMessage.includes('leadgen')) {
      throw new AppError(errors.metaFormsPermissionMissing, 403, 'META_PERMISSION_MISSING', {
        action: 'RECONNECT',
      })
    }
    throw new AppError(errors.metaPermissionMissing, 403, 'META_PERMISSION_MISSING', {
      action: 'RECONNECT',
    })
  }
  throw new AppError(errors.metaExchangeFailed, 502, 'META_GRAPH_ERROR')
}

async function readGraphPayload(response, options = {}) {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    throw new AppError(errors.metaExchangeFailed, 502)
  }
  if (!response.ok) {
    throwMappedGraphError(payload, response.status, options)
  }
  if (!payload) {
    throw new AppError(errors.metaExchangeFailed, 502)
  }
  return payload
}

async function exchangeAuthorizationCode({ appId, appSecret, redirectUri, code }) {
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/oauth/access_token`)
  url.searchParams.set('client_id', appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code', code)
  const response = await fetchImpl(url)
  const payload = await readGraphPayload(response)
  if (!payload.access_token) {
    throw new AppError(errors.metaExchangeFailed, 502)
  }
  return {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in,
  }
}

/**
 * WhatsApp Embedded Signup code exchange (Tech Provider / Tech Partner).
 * Meta docs: GET /oauth/access_token with client_id, client_secret, code — no redirect_uri.
 *
 * @param {{ appId: string, appSecret: string, code: string, graphVersion?: string }} params
 */
async function exchangeEmbeddedSignupCode({ appId, appSecret, code, graphVersion }) {
  const version = String(graphVersion || readGraphVersion()).trim()
  const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`)
  url.searchParams.set('client_id', appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('code', code)
  const response = await fetchImpl(url)
  const payload = await readGraphPayload(response)
  if (!payload.access_token) {
    throw new AppError(errors.whatsappSignupExchangeFailed, 502)
  }
  return {
    accessToken: String(payload.access_token),
    tokenType: payload.token_type ? String(payload.token_type) : 'bearer',
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : null,
  }
}

/**
 * Inspects a business token via debug_token using the app access token.
 * Never logs the tokens themselves.
 *
 * @param {{ appId: string, appSecret: string, inputToken: string, graphVersion?: string }} params
 */
async function debugAccessToken({ appId, appSecret, inputToken, graphVersion }) {
  const version = String(graphVersion || readGraphVersion()).trim()
  const url = new URL(`https://graph.facebook.com/${version}/debug_token`)
  url.searchParams.set('input_token', inputToken)
  const appAccessToken = `${appId}|${appSecret}`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${appAccessToken}` },
  })
  const payload = await readGraphPayload(response)
  const data = payload && payload.data ? payload.data : {}
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.map((item) => String(item))
    : []
  const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes : []
  const targetIds = []
  for (const row of granular) {
    if (!row || !Array.isArray(row.target_ids)) continue
    for (const id of row.target_ids) {
      if (id !== undefined && id !== null && id !== '') {
        targetIds.push(String(id))
      }
    }
  }
  return {
    isValid: data.is_valid !== false,
    appId: data.app_id ? String(data.app_id) : null,
    type: data.type ? String(data.type) : null,
    scopes,
    targetIds: [...new Set(targetIds)],
    expiresAt: data.expires_at || null,
    dataAccessExpiresAt: data.data_access_expires_at || null,
  }
}

/**
 * Verifies WABA accessibility with the customer business token.
 *
 * @param {{ accessToken: string, wabaId: string, graphVersion?: string }} params
 */
async function readWhatsAppBusinessAccount({ accessToken, wabaId, graphVersion }) {
  const version = String(graphVersion || readGraphVersion()).trim()
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}`)
  url.searchParams.set(
    'fields',
    'id,name,currency,account_review_status,business_verification_status,ownership_type',
  )
  url.searchParams.set('access_token', accessToken)
  const response = await fetchImpl(url)
  const payload = await readGraphPayload(response)
  if (!payload.id) {
    throw new AppError(errors.whatsappSignupWabaInvalid, 400)
  }
  return {
    id: String(payload.id),
    name: payload.name ? String(payload.name) : '',
    currency: payload.currency ? String(payload.currency) : null,
    accountReviewStatus: payload.account_review_status
      ? String(payload.account_review_status)
      : null,
    businessVerificationStatus: payload.business_verification_status
      ? String(payload.business_verification_status)
      : null,
    ownershipType: payload.ownership_type ? String(payload.ownership_type) : null,
  }
}

/**
 * Lists phone numbers on a WABA and returns a normalized row for the given phone ID.
 *
 * @param {{ accessToken: string, wabaId: string, phoneNumberId?: string, graphVersion?: string }} params
 */
async function listWhatsAppPhoneNumbers({ accessToken, wabaId, phoneNumberId, graphVersion }) {
  const version = String(graphVersion || readGraphVersion()).trim()
  const url = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/phone_numbers`,
  )
  url.searchParams.set(
    'fields',
    'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput',
  )
  url.searchParams.set('access_token', accessToken)
  const response = await fetchImpl(url)
  const payload = await readGraphPayload(response)
  const rows = Array.isArray(payload.data) ? payload.data : []
  const phones = rows
    .filter((row) => row && row.id)
    .map((row) => ({
      id: String(row.id),
      displayPhoneNumber: row.display_phone_number ? String(row.display_phone_number) : null,
      verifiedName: row.verified_name ? String(row.verified_name) : null,
      qualityRating: row.quality_rating ? String(row.quality_rating) : null,
      codeVerificationStatus: row.code_verification_status
        ? String(row.code_verification_status)
        : null,
      platformType: row.platform_type ? String(row.platform_type) : null,
      messagingLimitTier: row.throughput && row.throughput.level
        ? String(row.throughput.level)
        : null,
    }))
  if (!phoneNumberId) {
    return { phones, matched: null }
  }
  const matched = phones.find((row) => row.id === String(phoneNumberId)) || null
  return { phones, matched }
}

async function exchangeLongLivedToken({ appId, appSecret, accessToken }) {
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/oauth/access_token`)
  url.searchParams.set('grant_type', 'fb_exchange_token')
  url.searchParams.set('client_id', appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('fb_exchange_token', accessToken)
  const response = await fetchImpl(url)
  const payload = await readGraphPayload(response)
  if (!payload.access_token) {
    throw new AppError(errors.metaExchangeFailed, 502)
  }
  return {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in,
  }
}

async function readFacebookUser(accessToken) {
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/me`)
  url.searchParams.set('fields', 'id,name')
  url.searchParams.set('access_token', accessToken)
  const response = await fetchImpl(url)
  const payload = await readGraphPayload(response)
  if (!payload.id) {
    throw new AppError(errors.metaExchangeFailed, 502)
  }
  return { id: String(payload.id), name: payload.name ? String(payload.name) : '' }
}

async function readGrantedPermissions(accessToken) {
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/me/permissions`)
  url.searchParams.set('access_token', accessToken)
  const response = await fetchImpl(url)
  const payload = await readGraphPayload(response)
  const granted = []
  const declined = []
  if (payload && Array.isArray(payload.data)) {
    for (const row of payload.data) {
      if (!row || !row.permission) continue
      const name = String(row.permission)
      if (row.status === 'granted') {
        granted.push(name)
      } else {
        declined.push(name)
      }
    }
  }
  return { granted, declined }
}

/**
 * Lists Pages the user manages, following paging.next until complete (or guard).
 * Never returns personal profiles — only /me/accounts.
 */
async function readFacebookPages(accessToken) {
  const pages = []
  const first = new URL(`https://graph.facebook.com/${readGraphVersion()}/me/accounts`)
  first.searchParams.set('fields', 'id,name,access_token')
  first.searchParams.set('limit', '100')
  first.searchParams.set('access_token', accessToken)
  let nextUrl = first.toString()
  let guard = 0
  while (nextUrl) {
    guard += 1
    if (guard > security.metaPageListLimit) {
      break
    }
    const response = await fetchImpl(nextUrl)
    const payload = await readGraphPayload(response)
    if (Array.isArray(payload.data)) {
      for (const page of payload.data) {
        if (page && page.id && page.access_token) {
          pages.push({
            id: String(page.id),
            name: page.name ? String(page.name) : String(page.id),
            access_token: String(page.access_token),
          })
        }
      }
    }
    nextUrl = ''
    if (payload.paging && payload.paging.next) {
      nextUrl = payload.paging.next
    }
  }
  return pages
}

async function subscribePageLeadgen(accessToken, pageId) {
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/${pageId}/subscribed_apps`)
  url.searchParams.set('subscribed_fields', messages.metaLeadgenField)
  url.searchParams.set('access_token', accessToken)
  const response = await fetchImpl(url, { method: 'POST' })
  await readGraphPayload(response)
}

async function unsubscribePageLeadgen(accessToken, pageId) {
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/${pageId}/subscribed_apps`)
  url.searchParams.set('access_token', accessToken)
  const response = await fetchImpl(url, { method: 'DELETE' })
  await readGraphPayload(response)
}

/**
 * Follows paging.next for a Graph edge until complete or pageLimit.
 */
async function readPagedEdge(accessToken, startPath, fields, options = {}) {
  const rows = []
  const first = new URL(`https://graph.facebook.com/${readGraphVersion()}/${startPath}`)
  first.searchParams.set('fields', fields)
  first.searchParams.set('limit', '100')
  first.searchParams.set('access_token', accessToken)
  let pageLimit = security.metaLeadPageLimit
  if (typeof options.pageLimit === 'number' && options.pageLimit > 0) {
    pageLimit = options.pageLimit
  }
  let nextUrl = first.toString()
  let guard = 0
  while (nextUrl) {
    guard += 1
    if (guard > pageLimit) break
    const response = await fetchImpl(nextUrl)
    const payload = await readGraphPayload(response, options)
    if (Array.isArray(payload.data)) {
      for (const row of payload.data) {
        rows.push(row)
      }
    }
    nextUrl = ''
    if (payload.paging && payload.paging.next) {
      nextUrl = payload.paging.next
    }
  }
  return rows
}

async function readLead(accessToken, leadgenId) {
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/${leadgenId}`)
  url.searchParams.set('fields', 'created_time,id,ad_id,adset_id,campaign_id,form_id,field_data')
  url.searchParams.set('access_token', accessToken)
  const response = await fetchImpl(url)
  return readGraphPayload(response, { purpose: 'leads' })
}

async function readLeadgenForms(accessToken, pageId, options = {}) {
  return readPagedEdge(accessToken, `${pageId}/leadgen_forms`, 'id,name', {
    ...options,
    purpose: 'forms',
  })
}

async function readFormLeads(accessToken, formId, options = {}) {
  return readPagedEdge(
    accessToken,
    `${formId}/leads`,
    'created_time,id,ad_id,adset_id,campaign_id,form_id,field_data',
    { ...options, purpose: 'leads' },
  )
}

async function readObjectName(accessToken, objectId) {
  if (!objectId) return ''
  const url = new URL(`https://graph.facebook.com/${readGraphVersion()}/${objectId}`)
  url.searchParams.set('fields', 'name')
  url.searchParams.set('access_token', accessToken)
  try {
    const response = await fetchImpl(url)
    const payload = await readGraphPayload(response, { purpose: 'leads' })
    return payload.name ? String(payload.name) : ''
  } catch {
    return ''
  }
}

module.exports = {
  debugAccessToken,
  exchangeAuthorizationCode,
  exchangeEmbeddedSignupCode,
  exchangeLongLivedToken,
  listWhatsAppPhoneNumbers,
  readFacebookPages,
  readFacebookUser,
  readFormLeads,
  readGrantedPermissions,
  readGraphVersion,
  readLead,
  readLeadgenForms,
  readObjectName,
  readPagedEdge,
  readWhatsAppBusinessAccount,
  resetFetchImpl,
  setFetchImpl,
  subscribePageLeadgen,
  unsubscribePageLeadgen,
  throwMappedGraphError,
}
