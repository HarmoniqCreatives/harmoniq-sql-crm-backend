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

function normalizeMailAttachments(attachments) {
  if (!attachments || !Array.isArray(attachments)) {
    return []
  }
  return attachments.map((item) => {
    const filename = item && item.filename ? String(item.filename) : 'attachment.csv'
    const content = item && item.content !== undefined && item.content !== null
      ? item.content
      : ''
    const contentType = item && item.contentType ? String(item.contentType) : 'text/csv'
    return { filename, content, contentType }
  })
}

function normalizeRecipientList(to) {
  if (Array.isArray(to)) {
    return to.map((item) => String(item || '').trim()).filter(Boolean)
  }
  const single = String(to || '').trim()
  return single ? [single] : []
}

async function sendViaMemory(payload) {
  memoryOutbox.push({
    ...payload,
    attachments: normalizeMailAttachments(payload.attachments),
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
  const files = normalizeMailAttachments(payload.attachments)
  const mail = {
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    from: process.env.MAIL_FROM,
  }
  if (files.length > 0) {
    mail.attachments = files.map((file) => ({
      filename: file.filename,
      content: file.content,
      contentType: file.contentType,
    }))
  }
  return withTimeout(transport.sendMail(mail), MAIL_TIMEOUT_MS)
}

async function sendViaResend(payload) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || !process.env.MAIL_FROM) {
    throw new AppError(errors.mailNotConfigured, 503)
  }
  const recipients = normalizeRecipientList(payload.to)
  const body = {
    from: process.env.MAIL_FROM,
    to: recipients,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  }
  const files = normalizeMailAttachments(payload.attachments)
  if (files.length > 0) {
    body.attachments = files.map((file) => ({
      filename: file.filename,
      content: Buffer.isBuffer(file.content)
        ? file.content.toString('base64')
        : Buffer.from(String(file.content), 'utf8').toString('base64'),
    }))
  }
  const response = await withTimeout(fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), MAIL_TIMEOUT_MS)

  if (!response.ok) {
    const error = new Error(`Resend request failed (${response.status})`)
    error.code = `RESEND_${response.status}`
    throw error
  }
  const responseBody = await response.json().catch(() => ({}))
  return { messageId: responseBody.id || '' }
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

const DEFAULT_NEW_LEAD_SUBJECT = 'New Lead Assigned – Harmoniq CRM'
const DEFAULT_TRANSFER_SUBJECT = 'Lead Transferred to You – Harmoniq CRM'

function assignmentIntroLine(emailKind) {
  if (emailKind === 'transfer') {
    return 'A lead has been transferred to you.'
  }
  return 'A new lead has been assigned to you.'
}

function buildAssignmentMessageText(details) {
  const lines = [
    'Hello,',
    '',
    assignmentIntroLine(details.emailKind),
    '',
    `Assigned By: ${details.assignedBy || ''}`,
    `Contact Name: ${details.contactName || ''}`,
    `Number: ${details.contactNumber || ''}`,
  ]
  if (details.emailKind === 'transfer') {
    if (details.previousAgentName) {
      lines.push(`Previous Agent: ${details.previousAgentName}`)
    }
    if (details.transferReason) {
      lines.push(`Transfer Reason: ${details.transferReason}`)
    }
  }
  lines.push('', 'Please contact the lead and follow up.', '', 'Regards,', 'Harmoniq CRM')
  return lines.join('\n')
}

function buildAssignmentMessageHtml(details) {
  const transferBits = []
  if (details.emailKind === 'transfer') {
    if (details.previousAgentName) {
      transferBits.push(`Previous Agent: ${escapeHtml(details.previousAgentName)}<br>`)
    }
    if (details.transferReason) {
      transferBits.push(`Transfer Reason: ${escapeHtml(details.transferReason)}<br>`)
    }
  }
  return [
    '<p>Hello,</p>',
    `<p>${escapeHtml(assignmentIntroLine(details.emailKind))}</p>`,
    `<p>Assigned By: ${escapeHtml(details.assignedBy || '')}<br>`,
    `Contact Name: ${escapeHtml(details.contactName || '')}<br>`,
    `Number: ${escapeHtml(details.contactNumber || '')}<br>`,
    ...transferBits,
    '</p>',
    '<p>Please contact the lead and follow up.</p>',
    '<p>Regards,<br>Harmoniq CRM</p>',
  ].join('')
}

function resolveAssignmentEmailSubject(details) {
  if (details && details.subject && String(details.subject).trim()) {
    return String(details.subject).trim()
  }
  if (details && details.emailKind === 'transfer') {
    return DEFAULT_TRANSFER_SUBJECT
  }
  return DEFAULT_NEW_LEAD_SUBJECT
}

/**
 * Sends new-lead or transfer assignment email via the configured provider.
 * @param {object} details
 */
async function sendAssignmentEmail(details) {
  const text = buildAssignmentMessageText(details)
  const html = buildAssignmentMessageHtml(details)
  const subject = resolveAssignmentEmailSubject(details)
  await sendMail('assignment', {
    to: details.to,
    subject,
    text,
    html,
  })
}

/**
 * Sends a scheduled lead report to one or more recipients with CSV attachments.
 * @param {object} details
 */
async function sendDailyLeadReportEmail(details) {
  if (!details || typeof details !== 'object') {
    throw new AppError(errors.mailNotConfigured, 503)
  }
  const recipients = normalizeRecipientList(details.recipients)
  if (recipients.length === 0) {
    throw new AppError(errors.emailReportRecipientsInvalid, 400)
  }
  await sendMail('email_report', {
    to: recipients,
    subject: details.subject || 'Lead report',
    text: details.text || '',
    html: details.html || '',
    attachments: details.attachments || [],
  })
  return { provider: readMailProvider() || 'smtp' }
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
  sendAssignmentEmail,
  sendDailyLeadReportEmail,
  resolveAssignmentEmailSubject,
  buildAssignmentMessageText,
  buildAssignmentMessageHtml,
  DEFAULT_NEW_LEAD_SUBJECT,
  DEFAULT_TRANSFER_SUBJECT,
  shortMailError,
  warnMailProviderAtStartup,
  getMemoryOutbox,
  clearMemoryOutbox,
  normalizeMailAttachments,
  isMailConfigured: isSmtpConfigured,
}
