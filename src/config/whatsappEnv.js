const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')

/**
 * Platform-owned WhatsApp Embedded Signup credentials.
 * Separate from Facebook Lead Ads OAuth (META_REDIRECT_URI / page tokens).
 * One Meta App may power both products with distinct auth flows.
 */

function readFlag(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * @returns {string}
 */
function readWhatsAppGraphVersion() {
  return String(
    process.env.WHATSAPP_GRAPH_API_VERSION
    || process.env.META_GRAPH_API_VERSION
    || process.env.META_GRAPH_VERSION
    || messages.defaultWhatsAppGraphVersion
    || messages.defaultGraphVersion
  ).trim()
}

/**
 * @returns {{
 *   enabled: boolean,
 *   appId: string,
 *   appSecret: string,
 *   configId: string,
 *   graphApiVersion: string,
 *   requiredScopes: string[],
 * }}
 */
function readWhatsAppEmbeddedSignupConfig() {
  const appId = String(process.env.WHATSAPP_APP_ID || '').trim()
  const appSecret = String(process.env.WHATSAPP_APP_SECRET || '').trim()
  const configId = String(process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || '').trim()
  const graphApiVersion = readWhatsAppGraphVersion()
  const enabledFlag = process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED
  const enabled = enabledFlag === undefined || enabledFlag === ''
    ? Boolean(appId && appSecret && configId)
    : readFlag('WHATSAPP_EMBEDDED_SIGNUP_ENABLED')

  const requiredScopes = String(messages.whatsappRequiredScopes)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return {
    enabled,
    appId,
    appSecret,
    configId,
    graphApiVersion,
    requiredScopes,
  }
}

/**
 * Validates Embedded Signup is enabled and fully configured.
 * Never returns the app secret to callers that serialize to HTTP.
 *
 * @returns {{
 *   appId: string,
 *   appSecret: string,
 *   configId: string,
 *   graphApiVersion: string,
 *   requiredScopes: string[],
 * }}
 */
function assertWhatsAppEmbeddedSignupReady() {
  const config = readWhatsAppEmbeddedSignupConfig()
  if (!config.enabled) {
    throw new AppError(errors.whatsappSignupDisabled, 503)
  }
  if (!config.appId || !config.appSecret || !config.configId) {
    throw new AppError(errors.whatsappSignupConfigMissing, 503)
  }
  if (!/^v\d+(\.\d+)?$/.test(config.graphApiVersion)) {
    throw new AppError(errors.whatsappSignupConfigMissing, 503)
  }
  return config
}

/**
 * Public SDK bootstrap payload — never includes app secret.
 *
 * @returns {{
 *   enabled: boolean,
 *   appId: string|null,
 *   configId: string|null,
 *   graphApiVersion: string,
 *   extras: { setup: object },
 *   loginOptions: { responseType: string, overrideDefaultResponseType: boolean },
 * }}
 */
function presentEmbeddedSignupClientConfig() {
  const config = readWhatsAppEmbeddedSignupConfig()
  return {
    enabled: Boolean(config.enabled && config.appId && config.appSecret && config.configId),
    appId: config.appId || null,
    configId: config.configId || null,
    graphApiVersion: config.graphApiVersion,
    extras: { setup: {} },
    loginOptions: {
      responseType: 'code',
      overrideDefaultResponseType: true,
    },
  }
}

/**
 * True when public webhook GET verify token and POST app secret are configured.
 */
function isWhatsAppWebhookConfigured() {
  return Boolean(
    String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim()
    && String(process.env.WHATSAPP_APP_SECRET || '').trim(),
  )
}

module.exports = {
  readWhatsAppGraphVersion,
  readWhatsAppEmbeddedSignupConfig,
  assertWhatsAppEmbeddedSignupReady,
  presentEmbeddedSignupClientConfig,
  isWhatsAppWebhookConfigured,
}
