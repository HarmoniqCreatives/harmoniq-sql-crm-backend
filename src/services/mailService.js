const nodemailer = require('nodemailer')
const { AppError, errors } = require('../utils/errors')

const memoryOutbox = []
/** Hard timeout so Render SMTP hangs cannot stall the API for minutes. */
const MAIL_TIMEOUT_MS = 10_000

/**
 * Mail provider abstraction for verification, password reset, and invitations.
 *
 * Production on Render should use `MAIL_PROVIDER=resend` (HTTPS). SMTP is for
 * local development. Invite links are built from `APP_BASE_URL` and never fall
 * back to localhost in production. Logs omit tokens and credentials.
 */

function normalizeFrontendBase(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function isLocalFrontendUrl(base) {
  const lower = String(base || '').toLowerCase()
  return lower.includes('localhost') || lower.includes('127.0.0.1')
}

/**
 * Resolves the public frontend base for email/copy links.
 *
 * @returns {string} https origin without trailing slash
 * @throws {AppError} when production config is missing/invalid
 */
function readAppBaseUrl() {
  const configured = process.env.APP_BASE_URL
  if (configured) {
    const base = normalizeFrontendBase(configured)
    if (process.env.NODE_ENV === 'production') {
      if (!base.startsWith('https://') || isLocalFrontendUrl(base)) {
        throw new AppError(errors.appBaseUrlInvalid, 503)
      }
    }
    return base
  }

  const frontendUrl = process.env.FRONTEND_URL
  if (!frontendUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(errors.appBaseUrlMissing, 503)
    }
    throw new AppError(errors.mailNotConfigured, 503)
  }

  const base = normalizeFrontendBase(frontendUrl)
  if (process.env.NODE_ENV === 'production') {
    if (isLocalFrontendUrl(base) || !base.startsWith('https://')) {
      throw new AppError(errors.appBaseUrlMissing, 503)
    }
  }
  return base
}

function resolvePublicFrontendBase(req) {
  try {
    return readAppBaseUrl()
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error
    }
    let origin = ''
    if (req && typeof req.get === 'function') {
      const header = req.get('origin')
      if (header) {
        origin = normalizeFrontendBase(header)
      }
    }
    if (origin) {
      return origin
    }
    throw error
  }
}

function acceptInvitationLink(token, frontendBase) {
  let base = frontendBase
  if (!base) {
    base = readAppBaseUrl()
  }
  return `${base}/accept-invitation?token=${encodeURIComponent(token)}`
}

function readMailProvider() {
  if (process.env.MAIL_DRIVER === 'memory') {
    return 'memory'
  }
  const raw = process.env.MAIL_PROVIDER
  if (!raw) {
    return ''
  }
  return String(raw).trim().toLowerCase()
}

function warnMailProviderAtStartup() {
  if (process.env.NODE_ENV !== 'production') {
    return
  }
  const provider = readMailProvider()
  if (!provider) {
    console.warn(JSON.stringify({
      event: 'mail_provider_unset',
      message: 'MAIL_PROVIDER is unset in production. Set MAIL_PROVIDER=resend (recommended on Render) or MAIL_PROVIDER=smtp.',
    }))
    return
  }
  if (provider !== 'resend' && provider !== 'smtp' && provider !== 'memory') {
    console.warn(JSON.stringify({
      event: 'mail_provider_invalid',
      message: errors.mailProviderInvalid,
    }))
  }
}

function isSmtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST
    && process.env.SMTP_PORT
    && process.env.SMTP_USER
    && process.env.SMTP_PASS
    && process.env.MAIL_FROM,
  )
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Connection timeout')
      error.code = 'ETIMEDOUT'
      reject(error)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function shortMailError(error) {
  if (!error) {
    return 'Mail send failed'
  }
  if (error.code) {
    return String(error.code).slice(0, 80)
  }
  return String(error.message || 'Mail send failed').slice(0, 80)
}

function logMailSendResult(kind, info, provider) {
  console.log(JSON.stringify({
    event: 'mail_send_result',
    kind,
    provider,
    messageId: info && info.messageId ? info.messageId : '',
  }))
}

function logMailSendError(kind, error, provider) {
  console.error(JSON.stringify({
    event: 'mail_send_error',
    kind,
    provider,
    code: error && error.code ? String(error.code) : '',
    message: error && error.message ? String(error.message) : 'Mail send failed',
  }))
}

async function sendViaMemory(payload) {
  memoryOutbox.push({
    ...payload,
    at: new Date().toISOString(),
  })
  return { messageId: `memory-${memoryOutbox.length}` }
}

async function sendViaSmtp(payload) {
  if (!isSmtpConfigured()) {
    throw new AppError(errors.mailNotConfigured, 503)
  }
  const port = Number(process.env.SMTP_PORT)
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
    auth: {
      user: process.env.SMTP_USER,
      pass: String(process.env.SMTP_PASS).replace(/\s+/g, ''),
    },
  })
  return withTimeout(transport.sendMail({
    ...payload,
    from: process.env.MAIL_FROM,
  }), MAIL_TIMEOUT_MS)
}

async function sendViaResend(payload) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || !process.env.MAIL_FROM) {
    throw new AppError(errors.mailNotConfigured, 503)
  }
  const response = await withTimeout(fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: [payload.to],
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    }),
  }), MAIL_TIMEOUT_MS)

  if (!response.ok) {
    const error = new Error(`Resend request failed (${response.status})`)
    error.code = `RESEND_${response.status}`
    throw error
  }
  const body = await response.json().catch(() => ({}))
  return { messageId: body.id || '' }
}

async function sendMail(kind, payload) {
  const provider = readMailProvider() || (process.env.NODE_ENV === 'production' ? 'resend' : 'smtp')
  try {
    let info
    if (provider === 'memory') {
      info = await sendViaMemory(payload)
    } else if (provider === 'resend') {
      info = await sendViaResend(payload)
    } else if (provider === 'smtp') {
      info = await sendViaSmtp(payload)
    } else {
      throw new AppError(errors.mailProviderInvalid, 503)
    }
    logMailSendResult(kind, info, provider)
    return info
  } catch (error) {
    logMailSendError(kind, error, provider)
    throw error
  }
}

async function sendVerificationEmail(details) {
  const link = `${readAppBaseUrl()}/verify-email?token=${encodeURIComponent(details.token)}`
  await sendMail('verification', {
    to: details.to,
    subject: 'Verify your Harmoniq Creative CRM email',
    text: [
      `Hello ${details.recipientName},`,
      '',
      `Confirm ${details.companyName} by opening this link:`,
      link,
      '',
      'This link expires in 24 hours.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(details.recipientName)},</p>`,
      `<p>Confirm ${escapeHtml(details.companyName)} in Harmoniq Creative CRM.</p>`,
      `<p><a href="${escapeHtml(link)}">Verify email</a></p>`,
      '<p>This link expires in 24 hours.</p>',
    ].join(''),
  })
  return { link }
}

async function sendPasswordResetEmail(details) {
  const link = `${readAppBaseUrl()}/reset-password?token=${encodeURIComponent(details.token)}`
  await sendMail('password_reset', {
    to: details.to,
    subject: 'Reset your Harmoniq Creative CRM password',
    text: [
      `Hello ${details.recipientName},`,
      '',
      'Use this link to choose a new password:',
      link,
      '',
      'This link expires in 1 hour.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(details.recipientName)},</p>`,
      `<p><a href="${escapeHtml(link)}">Reset password</a></p>`,
      '<p>This link expires in 1 hour.</p>',
    ].join(''),
  })
  return { link }
}

/**
 * Sends an invitation email containing a one-time accept link.
 *
 * @param {object} details to, recipientName, inviterName, companyName, roleName, token, frontendBase?
 * @returns {Promise<{ link: string }>}
 */
async function sendInvitationEmail(details) {
  const link = acceptInvitationLink(details.token, details.frontendBase)
  await sendMail('invitation', {
    to: details.to,
    subject: `You are invited to ${details.companyName}`,
    text: [
      `Hello ${details.recipientName},`,
      '',
      `${details.inviterName} invited you to ${details.companyName} as ${details.roleName}.`,
      'Accept the invitation:',
      link,
      '',
      'This link expires in 24 hours.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(details.recipientName)},</p>`,
      `<p>${escapeHtml(details.inviterName)} invited you to ${escapeHtml(details.companyName)} as ${escapeHtml(details.roleName)}.</p>`,
      `<p><a href="${escapeHtml(link)}">Accept invitation</a></p>`,
      '<p>This link expires in 24 hours.</p>',
    ].join(''),
  })
  return { link }
}

function getMemoryOutbox() {
  return memoryOutbox.slice()
}

function clearMemoryOutbox() {
  memoryOutbox.length = 0
}

module.exports = {
  readAppBaseUrl,
  resolvePublicFrontendBase,
  acceptInvitationLink,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendInvitationEmail,
  shortMailError,
  warnMailProviderAtStartup,
  getMemoryOutbox,
  clearMemoryOutbox,
  isMailConfigured: isSmtpConfigured,
}
