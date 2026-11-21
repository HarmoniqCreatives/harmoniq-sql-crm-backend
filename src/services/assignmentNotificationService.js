const { getModels } = require('../models')
const { PRODUCT_NAME } = require('../config/brand')
const mailService = require('./mailService')
const { userStatuses } = require('../utils/enums')

const META_ASSIGNED_BY = 'Meta Integration'
const EMAIL_KINDS = {
  newLead: 'new_lead',
  transfer: 'transfer',
}
const ASSIGNMENT_EMAIL_SUBJECTS = {
  new_lead: `New Lead Assigned – ${PRODUCT_NAME}`,
  transfer: `Lead Transferred to You – ${PRODUCT_NAME}`,
}

/** Short-lived keys so shared createLead paths cannot double-queue the same notice. */
const recentNotificationKeys = new Map()
const DEDUPE_TTL_MS = 60_000

/**
 * Operators can disable assignment mail without removing hooks.
 * @returns {boolean}
 */
function assignmentEmailEnabled() {
  const raw = process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return true
  }
  return String(raw).trim() !== '0'
}

/**
 * New-lead gate: null → agent (or A → B) with a real new primary.
 * @param {string|null|undefined} previousPrimaryAgentId
 * @param {string|null|undefined} newPrimaryAgentId
 */
function shouldNotifyPrimaryChange(previousPrimaryAgentId, newPrimaryAgentId) {
  if (!newPrimaryAgentId) {
    return false
  }
  if (!previousPrimaryAgentId) {
    return true
  }
  return String(previousPrimaryAgentId) !== String(newPrimaryAgentId)
}

/**
 * Transfer gate: only when primary moves from one agent to another (not null → A).
 * @param {string|null|undefined} previousPrimaryAgentId
 * @param {string|null|undefined} newPrimaryAgentId
 */
function shouldNotifyTransfer(previousPrimaryAgentId, newPrimaryAgentId) {
  if (!previousPrimaryAgentId || !newPrimaryAgentId) {
    return false
  }
  return String(previousPrimaryAgentId) !== String(newPrimaryAgentId)
}

/**
 * @param {object} details
 * @returns {'new_lead'|'transfer'}
 */
function resolveEmailKind(details) {
  if (details && details.emailKind === EMAIL_KINDS.transfer) {
    return EMAIL_KINDS.transfer
  }
  return EMAIL_KINDS.newLead
}

/**
 * @param {string} emailKind
 * @returns {string}
 */
function resolveAssignmentEmailSubject(emailKind) {
  if (emailKind === EMAIL_KINDS.transfer) {
    return ASSIGNMENT_EMAIL_SUBJECTS.transfer
  }
  return ASSIGNMENT_EMAIL_SUBJECTS.new_lead
}

/**
 * @param {object} details
 * @returns {boolean}
 */
function shouldQueueForEmailKind(details) {
  const kind = resolveEmailKind(details)
  if (kind === EMAIL_KINDS.transfer) {
    return shouldNotifyTransfer(details.previousPrimaryAgentId, details.newPrimaryAgentId)
  }
  return shouldNotifyPrimaryChange(details.previousPrimaryAgentId, details.newPrimaryAgentId)
}

/**
 * @param {object} details
 * @returns {string}
 */
function buildDedupeKey(details) {
  const kind = resolveEmailKind(details)
  return [
    String(details.companyId || ''),
    String(details.leadId || ''),
    kind,
    String(details.newPrimaryAgentId || ''),
    String(details.previousPrimaryAgentId || ''),
  ].join(':')
}

/**
 * @param {string} key
 * @returns {boolean} true when this key was already seen recently
 */
function claimNotificationKey(key) {
  const now = Date.now()
  for (const [existing, expiresAt] of recentNotificationKeys.entries()) {
    if (expiresAt <= now) {
      recentNotificationKeys.delete(existing)
    }
  }
  if (recentNotificationKeys.has(key)) {
    return false
  }
  recentNotificationKeys.set(key, now + DEDUPE_TTL_MS)
  return true
}

/** Exists so unit tests can clear the in-process dedupe map. */
function clearNotificationDedupe() {
  recentNotificationKeys.clear()
}

/**
 * @param {object} details
 * @param {Function} [mailer]
 */
function queueLeadAssignmentEmail(details, mailer) {
  setImmediate(() => {
    deliverLeadAssignmentEmail(details, mailer).catch((error) => {
      let statusCode = null
      if (error && typeof error.statusCode === 'number') {
        statusCode = error.statusCode
      }
      console.error(JSON.stringify({
        event: 'assignment_email_background_failed',
        companyId: details.companyId ? String(details.companyId) : '',
        leadId: details.leadId ? String(details.leadId) : '',
        statusCode,
        message: error && error.message ? String(error.message).slice(0, 180) : 'assignment_email_failed',
        reason: mailService.shortMailError(error),
      }))
    })
  })
}

/**
 * Loads the assigned agent inside company scope and sends assignment mail.
 * Failures are logged; callers should treat this as best-effort.
 *
 * @param {object} details
 * @param {Function} [mailer]
 * @returns {Promise<{ sent: boolean, reason?: string, emailKind?: string, subject?: string }>}
 */
async function deliverLeadAssignmentEmail(details, mailer) {
  if (!assignmentEmailEnabled()) {
    return { sent: false, reason: 'disabled' }
  }
  if (!shouldQueueForEmailKind(details)) {
    return { sent: false, reason: 'unchanged_or_unassigned' }
  }
  if (!details.companyId || !details.newPrimaryAgentId) {
    return { sent: false, reason: 'missing_ids' }
  }

  const { User } = getModels()
  const agent = await User.findOne({
    where: {
      id: details.newPrimaryAgentId,
      companyId: details.companyId,
      status: userStatuses.active,
    },
    attributes: ['id', 'email', 'name', 'phone', 'companyId'],
  })
  if (!agent || !agent.email) {
    console.error(JSON.stringify({
      event: 'assignment_email_skipped',
      reason: 'agent_unavailable',
      companyId: String(details.companyId),
      leadId: details.leadId ? String(details.leadId) : '',
    }))
    return { sent: false, reason: 'agent_unavailable' }
  }

  let assignedBy = details.assignedByName
  if (!assignedBy) {
    assignedBy = META_ASSIGNED_BY
  }
  const contactName = details.contactName ? String(details.contactName) : ''
  const contactNumber = details.contactNumber ? String(details.contactNumber) : ''
  const transferReason = details.transferReason ? String(details.transferReason) : ''
  const previousAgentName = details.previousAgentName ? String(details.previousAgentName) : ''

  const emailKind = resolveEmailKind(details)
  const subject = resolveAssignmentEmailSubject(emailKind)
  const send = mailer || mailService.sendAssignmentEmail
  try {
    await send({
      to: agent.email,
      assignedBy,
      contactName,
      contactNumber,
      emailKind,
      subject,
      transferReason,
      previousAgentName,
    })
    console.info(JSON.stringify({
      event: 'assignment_email_sent',
      emailKind,
      companyId: String(details.companyId),
      leadId: details.leadId ? String(details.leadId) : '',
    }))
    return { sent: true, emailKind, subject }
  } catch (error) {
    console.error(JSON.stringify({
      event: 'assignment_email_failed',
      emailKind,
      companyId: String(details.companyId),
      leadId: details.leadId ? String(details.leadId) : '',
      reason: mailService.shortMailError(error),
      message: error && error.message ? String(error.message).slice(0, 180) : 'assignment_email_failed',
    }))
    return { sent: false, reason: 'send_failed' }
  }
}

/**
 * Non-blocking entry for createLead / assignLead. Dedupes rapid duplicate queues.
 *
 * @param {object} details
 * @param {Function} [mailer]
 * @returns {{ queued: boolean, reason?: string, emailKind?: string }}
 */
function notifyLeadPrimaryAssignment(details, mailer) {
  if (!shouldQueueForEmailKind(details)) {
    return { queued: false, reason: 'unchanged_or_unassigned' }
  }
  if (!assignmentEmailEnabled()) {
    return { queued: false, reason: 'disabled' }
  }
  const key = buildDedupeKey(details)
  if (!claimNotificationKey(key)) {
    return { queued: false, reason: 'duplicate' }
  }
  queueLeadAssignmentEmail(details, mailer)
  return { queued: true, emailKind: resolveEmailKind(details) }
}

module.exports = {
  META_ASSIGNED_BY,
  EMAIL_KINDS,
  ASSIGNMENT_EMAIL_SUBJECTS,
  assignmentEmailEnabled,
  shouldNotifyPrimaryChange,
  shouldNotifyTransfer,
  resolveEmailKind,
  resolveAssignmentEmailSubject,
  deliverLeadAssignmentEmail,
  notifyLeadPrimaryAssignment,
  queueLeadAssignmentEmail,
  clearNotificationDedupe,
  buildDedupeKey,
}
