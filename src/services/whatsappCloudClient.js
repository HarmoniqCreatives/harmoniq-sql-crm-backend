const { AppError, errors } = require('../utils/errors')
const { security } = require('../config/security')
const { readWhatsAppGraphVersion } = require('../config/whatsappEnv')

/** @type {typeof fetch} */
let fetchImpl = globalThis.fetch.bind(globalThis)

function setWhatsAppFetchImpl(impl) {
  fetchImpl = impl
}

function resetWhatsAppFetchImpl() {
  fetchImpl = globalThis.fetch.bind(globalThis)
}

function readTimeoutMs() {
  const raw = Number(security.whatsappGraphTimeoutMs)
  if (!Number.isFinite(raw) || raw < 1000) {
    return 20_000
  }
  return raw
}

/**
 * Maps Meta Graph errors without leaking tokens or raw bodies.
 * @param {object|null} payload
 * @param {number} httpStatus
 * @param {{ purpose?: string }} [options]
 */
function throwMappedWhatsAppError(payload, httpStatus, options = {}) {
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
  if (graphCode === 190 || graphCode === 102 || graphCode === 463 || graphCode === 467) {
    throw new AppError(errors.whatsappTokenExpired, 401, 'WHATSAPP_TOKEN_EXPIRED')
  }
  if (graphCode === 4 || graphCode === 17 || graphCode === 32 || graphCode === 613) {
    throw new AppError(errors.whatsappSendFailed, 429, 'WHATSAPP_RATE_LIMITED', { retryable: true })
  }
  if (graphCode === 133010 || graphCode === 131045) {
    throw new AppError(errors.whatsappPhoneNotRegistered, 400, 'WHATSAPP_PHONE_NOT_REGISTERED')
  }
  if (graphCode === 133016) {
    throw new AppError(errors.whatsappRegistrationFailed, 429, 'WHATSAPP_REGISTRATION_RATE_LIMITED', {
      retryable: false,
    })
  }
  if (options.purpose === 'register') {
    throw new AppError(errors.whatsappRegistrationFailed, httpStatus >= 400 ? httpStatus : 502, 'WHATSAPP_REGISTER_FAILED', {
      retryable: httpStatus >= 500 || httpStatus === 429,
    })
  }
  if (options.purpose === 'subscribe') {
    throw new AppError(errors.whatsappSendFailed, 502, 'WHATSAPP_SUBSCRIBE_FAILED', {
      retryable: httpStatus >= 500 || httpStatus === 429,
    })
  }
  if (options.purpose === 'templates') {
    throw new AppError(errors.whatsappTemplateSyncFailed, httpStatus >= 400 ? Math.min(httpStatus, 502) : 502, 'WHATSAPP_TEMPLATE_SYNC_FAILED', {
      retryable: httpStatus >= 500 || httpStatus === 429,
    })
  }
  if (options.purpose === 'verify') {
    throw new AppError(errors.whatsappVerifyFailed, httpStatus >= 400 ? Math.min(httpStatus, 502) : 502, 'WHATSAPP_VERIFY_FAILED', {
      retryable: httpStatus >= 500 || httpStatus === 429,
    })
  }
  const retryable = httpStatus >= 500 || httpStatus === 429 || graphCode === 1 || graphCode === 2
  let providerDetail = ''
  if (payload && payload.error && payload.error.error_data && typeof payload.error.error_data.details === 'string') {
    providerDetail = payload.error.error_data.details.trim().slice(0, 180)
  }
  let providerSummary = ''
  if (payload && payload.error && typeof payload.error.message === 'string') {
    providerSummary = payload.error.message
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
      .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
      .trim()
      .slice(0, 120)
  }
  const parts = [errors.whatsappSendFailed]
  if (graphCode) {
    parts.push(`[graphCode=${graphCode}]`)
  }
  if (providerSummary) {
    parts.push(providerSummary)
  }
  if (providerDetail) {
    parts.push(`— ${providerDetail}`)
  }
  throw new AppError(
    parts.join(' ').slice(0, 480),
    httpStatus >= 400 ? Math.min(httpStatus, 502) : 502,
    'WHATSAPP_GRAPH_ERROR',
    {
      retryable,
      graphCode: graphCode || undefined,
      hint: graphMessage ? 'provider_error' : undefined,
      providerDetail: providerDetail || undefined,
    },
  )
}

async function readJsonPayload(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * @param {string} url
 * @param {object} init
 * @param {{ purpose?: string }} [options]
 */
async function requestWhatsAppGraph(url, init, options = {}) {
  const controller = new AbortController()
  const timeoutMs = readTimeoutMs()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    })
    const payload = await readJsonPayload(response)
    if (!response.ok) {
      throwMappedWhatsAppError(payload, response.status, options)
    }
    return payload || {}
  } catch (error) {
    if (error instanceof AppError) {
      throw error
    }
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new AppError(errors.whatsappSendAmbiguous, 504, 'WHATSAPP_TIMEOUT_AMBIGUOUS', {
        retryable: false,
        ambiguous: true,
      })
    }
    throw new AppError(errors.whatsappSendFailed, 502, 'WHATSAPP_NETWORK_ERROR', { retryable: true })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Verifies credentials by reading the phone number node from Graph.
 * Never logs the access token.
 *
 * @param {{ accessToken: string, phoneNumberId: string, graphVersion?: string }} params
 */
async function verifyWhatsAppPhoneNumber({ accessToken, phoneNumberId, graphVersion }) {
  if (!accessToken || !phoneNumberId) {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }
  const version = String(graphVersion || readWhatsAppGraphVersion()).trim()
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}`)
  url.searchParams.set('fields', 'id,display_phone_number,verified_name,quality_rating')
  const payload = await requestWhatsAppGraph(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, { purpose: 'verify' })
  return {
    phoneNumberId: payload && payload.id ? String(payload.id) : String(phoneNumberId),
    displayPhoneNumber: payload && payload.display_phone_number
      ? String(payload.display_phone_number)
      : '',
    verifiedName: payload && payload.verified_name ? String(payload.verified_name) : '',
    qualityRating: payload && payload.quality_rating
      ? (typeof payload.quality_rating === 'object'
        ? String(payload.quality_rating.score || payload.quality_rating)
        : String(payload.quality_rating))
      : '',
  }
}

/**
 * Registers a business phone number for Cloud API.
 * PIN is never logged or returned.
 *
 * @param {{ accessToken: string, phoneNumberId: string, pin: string, graphVersion?: string }} params
 */
async function registerWhatsAppPhoneNumber({ accessToken, phoneNumberId, pin, graphVersion }) {
  const version = String(graphVersion || readWhatsAppGraphVersion()).trim()
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/register`
  const payload = await requestWhatsAppGraph(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      pin,
    }),
  }, { purpose: 'register' })
  return { success: payload.success === true }
}

/**
 * Subscribes the platform app to webhooks on the customer WABA.
 * Does not implement the public webhook receiver (P4).
 *
 * @param {{ accessToken: string, wabaId: string, graphVersion?: string }} params
 */
async function subscribeWhatsAppWabaApps({ accessToken, wabaId, graphVersion }) {
  const version = String(graphVersion || readWhatsAppGraphVersion()).trim()
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/subscribed_apps`
  const payload = await requestWhatsAppGraph(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, { purpose: 'subscribe' })
  return { success: payload.success === true }
}

/**
 * Lists apps subscribed to webhooks on a customer WABA.
 *
 * @param {{ accessToken: string, wabaId: string, graphVersion?: string }} params
 * @returns {Promise<{ appIds: string[] }>}
 */
async function listWhatsAppWabaSubscribedApps({ accessToken, wabaId, graphVersion }) {
  const version = String(graphVersion || readWhatsAppGraphVersion()).trim()
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/subscribed_apps`
  const payload = await requestWhatsAppGraph(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, { purpose: 'subscribe' })
  const rows = Array.isArray(payload.data) ? payload.data : []
  const appIds = []
  for (const row of rows) {
    if (row && row.id) {
      appIds.push(String(row.id))
      continue
    }
    if (row && row.whatsapp_business_api_data && row.whatsapp_business_api_data.id) {
      appIds.push(String(row.whatsapp_business_api_data.id))
    }
  }
  return { appIds: [...new Set(appIds)] }
}

/**
 * Only follow Meta Graph paging URLs for the configured API version.
 * @param {string} nextUrl
 * @param {string} graphVersion
 */
function isTrustedWhatsAppGraphPagingUrl(nextUrl, graphVersion) {
  try {
    const parsed = new URL(String(nextUrl || ''))
    if (parsed.protocol !== 'https:') return false
    if (parsed.hostname !== 'graph.facebook.com') return false
    const version = String(graphVersion || '').replace(/^\//, '')
    if (!version) return false
    return parsed.pathname.startsWith(`/${version}/`)
  } catch {
    return false
  }
}

/**
 * Lists message templates for a customer WABA with trusted pagination.
 *
 * @param {{ accessToken: string, wabaId: string, graphVersion?: string, pageLimit?: number }} params
 * @returns {Promise<{ templates: object[], pagesFetched: number, complete: boolean }>}
 */
async function listWhatsAppMessageTemplates({
  accessToken,
  wabaId,
  graphVersion,
  pageLimit,
}) {
  const version = String(graphVersion || readWhatsAppGraphVersion()).trim()
  const limit = Number.isFinite(pageLimit) && pageLimit > 0
    ? pageLimit
    : (Number(security.whatsappTemplatePageLimit) || 50)
  const fields = [
    'id',
    'name',
    'language',
    'status',
    'category',
    'quality_score',
    'rejected_reason',
    'parameter_format',
    'components',
  ].join(',')
  const first = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/message_templates`)
  first.searchParams.set('fields', fields)
  first.searchParams.set('limit', '100')

  const templates = []
  let nextUrl = first.toString()
  let pagesFetched = 0
  let complete = false

  while (nextUrl) {
    pagesFetched += 1
    if (pagesFetched > limit) {
      complete = false
      break
    }
    const payload = await requestWhatsAppGraph(nextUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }, { purpose: 'templates' })
    if (Array.isArray(payload.data)) {
      for (const row of payload.data) {
        if (row && typeof row === 'object') {
          templates.push(row)
        }
      }
    }
    const pagingNext = payload.paging && payload.paging.next ? String(payload.paging.next) : ''
    if (!pagingNext) {
      complete = true
      nextUrl = ''
      break
    }
    if (!isTrustedWhatsAppGraphPagingUrl(pagingNext, version)) {
      throw new AppError(errors.whatsappTemplateSyncFailed, 502, 'WHATSAPP_UNTRUSTED_PAGING_URL')
    }
    nextUrl = pagingNext
  }

  return { templates, pagesFetched, complete }
}

/**
 * Sends an approved template message via Cloud API.
 *
 * @param {{
 *   accessToken: string,
 *   phoneNumberId: string,
 *   to: string,
 *   templateName: string,
 *   language: string,
 *   bodyParameters?: string[],
 *   graphVersion?: string,
 * }} params
 */
async function sendWhatsAppTemplateMessage({
  accessToken,
  phoneNumberId,
  to,
  templateName,
  language,
  bodyParameters = [],
  graphVersion,
}) {
  const version = String(graphVersion || readWhatsAppGraphVersion()).trim()
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`
  const template = {
    name: templateName,
    language: { code: language },
  }
  if (Array.isArray(bodyParameters) && bodyParameters.length > 0) {
    template.components = [{
      type: 'body',
      parameters: bodyParameters.map((text) => ({
        type: 'text',
        text: String(text),
      })),
    }]
  }
  const payload = await requestWhatsAppGraph(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template,
    }),
  }, { purpose: 'send' })

  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const providerMessageId = messages[0] && messages[0].id ? String(messages[0].id) : null
  if (!providerMessageId) {
    throw new AppError(errors.whatsappSendFailed, 502, 'WHATSAPP_MISSING_MESSAGE_ID', { retryable: true })
  }
  return { providerMessageId }
}

module.exports = {
  setWhatsAppFetchImpl,
  resetWhatsAppFetchImpl,
  verifyWhatsAppPhoneNumber,
  registerWhatsAppPhoneNumber,
  subscribeWhatsAppWabaApps,
  listWhatsAppWabaSubscribedApps,
  listWhatsAppMessageTemplates,
  isTrustedWhatsAppGraphPagingUrl,
  sendWhatsAppTemplateMessage,
  throwMappedWhatsAppError,
}
