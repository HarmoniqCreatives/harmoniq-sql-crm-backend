const { getModels } = require('../models')
const {
  userStatuses,
  whatsappPhoneRegistrationStatuses,
  whatsappWorkflowKeys,
  whatsappTemplateVariableKeys,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const { isInternationalPhone, normalizePhone } = require('../utils/helpers')
const {
  shouldNotifyPrimaryChange,
  shouldNotifyTransfer,
  EMAIL_KINDS,
  resolveEmailKind,
} = require('./assignmentNotificationService')
const { enqueueWhatsAppMessage } = require('./whatsappOutboxService')
const { sanitizeAuditDetail } = require('./whatsappAuditService')

/** Meta hello_world is Test Message only — keep in sync with catalog binding guard. */
function isForbiddenWorkflowTemplateName(name) {
  return String(name || '').trim().toLowerCase() === 'hello_world'
}

const ALLOWED_VARIABLE_KEYS = new Set(whatsappTemplateVariableKeys)

/**
 * Counts BODY placeholders without importing the catalog service (avoids cycles).
 * @param {object[]} components
 * @returns {number}
 */
function countBodyPlaceholders(components) {
  if (!Array.isArray(components)) return 0
  const seen = new Set()
  for (const component of components) {
    if (!component || String(component.type || '').toUpperCase() !== 'BODY') continue
    const text = typeof component.text === 'string' ? component.text : ''
    for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      const token = String(match[1] || '').trim()
      if (token) seen.add(token)
    }
  }
  return seen.size
}

/**
 * Soft frontend base for CRM deep links — never throws when unset.
 * @returns {string}
 */
function readFrontendBaseSoft() {
  const configured = process.env.APP_BASE_URL || process.env.FRONTEND_URL || ''
  return String(configured).trim().replace(/\/$/, '')
}

/**
 * @param {string} leadId
 * @returns {string}
 */
function buildCrmLeadLink(leadId) {
  const base = readFrontendBaseSoft()
  if (!base || !leadId) {
    return ''
  }
  return `${base}/?lead=${encodeURIComponent(String(leadId))}`
}

function emptySafe(value) {
  if (value === undefined || value === null) {
    return ''
  }
  return String(value)
}

/**
 * @param {{ leadSnapshot?: object, leadId: string, agent?: { name?: string, phone?: string } }} args
 */
function buildAssignmentContext({ leadSnapshot, leadId, agent }) {
  const snapshot = leadSnapshot && typeof leadSnapshot === 'object' ? leadSnapshot : {}
  return {
    leadName: emptySafe(snapshot.name),
    leadPhone: emptySafe(snapshot.phone),
    campaignName: emptySafe(snapshot.campaignName),
    pageName: emptySafe(snapshot.facebookPageName || snapshot.pageName),
    facebookPageName: emptySafe(snapshot.facebookPageName || snapshot.pageName),
    crmLeadLink: buildCrmLeadLink(leadId),
    agentName: emptySafe(agent && agent.name),
    agentPhone: emptySafe(agent && agent.phone),
  }
}

/**
 * Maps ordered template bodyVariableKeys onto context. Unknown keys fail closed.
 *
 * @param {string[]} bodyVariableKeys
 * @param {object} context
 */
function mapBodyVariableKeys(bodyVariableKeys, context) {
  if (!Array.isArray(bodyVariableKeys)) {
    return { ok: false, reason: 'variable_keys_invalid', parameters: [], missingKey: '' }
  }
  const source = context && typeof context === 'object' ? context : {}
  const parameters = []
  for (const rawKey of bodyVariableKeys) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) {
      return { ok: false, reason: 'variable_unresolved', parameters: [], missingKey: '' }
    }
    if (!ALLOWED_VARIABLE_KEYS.has(key) && !Object.prototype.hasOwnProperty.call(source, key)) {
      return { ok: false, reason: 'variable_unresolved', parameters: [], missingKey: key }
    }
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      return { ok: false, reason: 'variable_unresolved', parameters: [], missingKey: key }
    }
    parameters.push(emptySafe(source[key]))
  }
  return { ok: true, reason: 'mapped', parameters, missingKey: '' }
}

function sanitizeLogMessage(error) {
  return sanitizeAuditDetail(
    error && error.message ? String(error.message) : 'whatsapp_assignment_failed',
  ).slice(0, 180)
}

function logSkip(details, reason, extra) {
  console.info(JSON.stringify({
    event: 'whatsapp_assignment_skipped',
    reason,
    companyId: details && details.companyId ? String(details.companyId) : '',
    leadId: details && details.leadId ? String(details.leadId) : '',
    workflowKey: details && details.workflowKey ? String(details.workflowKey) : '',
    ...(extra || {}),
  }))
}

/**
 * W1 idempotency — one notification per new-lead assignment to a primary.
 * @param {{ companyId: string, leadId: string, primaryAgentId: string }} args
 */
function buildMetaAssignIdempotencyKey({ companyId, leadId, primaryAgentId }) {
  return `w1:meta_assign:${companyId}:${leadId}:${primaryAgentId}`.slice(0, 191)
}

/**
 * W2 idempotency — one notification per successful LeadTransfer row.
 * Uses the committed transfer ID so a later repeated A→B is a new event.
 *
 * @param {{ companyId: string, leadId: string, transferId: string, primaryAgentId?: string }} args
 */
function buildTransferIdempotencyKey({
  companyId,
  leadId,
  transferId,
  primaryAgentId,
}) {
  const transfer = String(transferId || '').trim()
  if (!transfer) {
    throw new Error('transferId is required for WhatsApp transfer idempotency')
  }
  const parts = [
    'w2:transfer',
    String(companyId || ''),
    String(leadId || ''),
    transfer,
  ]
  if (primaryAgentId) {
    parts.push(String(primaryAgentId))
  }
  return parts.join(':').slice(0, 191)
}

/**
 * Resolves workflow key from email-kind style details.
 * @param {object} details
 * @returns {string}
 */
function resolveWorkflowKey(details) {
  if (details && details.workflowKey) {
    return String(details.workflowKey)
  }
  const kind = resolveEmailKind(details)
  if (kind === EMAIL_KINDS.transfer) {
    return whatsappWorkflowKeys.transfer
  }
  return whatsappWorkflowKeys.metaAssign
}

function shouldQueueForWorkflow(details, workflowKey) {
  if (workflowKey === whatsappWorkflowKeys.transfer) {
    return shouldNotifyTransfer(details.previousPrimaryAgentId, details.newPrimaryAgentId)
  }
  if (workflowKey === whatsappWorkflowKeys.metaAssign) {
    return shouldNotifyPrimaryChange(details.previousPrimaryAgentId, details.newPrimaryAgentId)
  }
  return false
}

/**
 * Loads binding + approved enabled template for a workflow key.
 *
 * @param {string} companyId
 * @param {string} workflowKey
 * @param {string|null} wabaId
 */
async function resolveBoundTemplate(companyId, workflowKey, wabaId) {
  const { WhatsAppWorkflowBinding, WhatsAppTemplate } = getModels()
  const binding = await WhatsAppWorkflowBinding.findOne({
    where: { companyId, workflowKey },
  })
  if (!binding) {
    return { ok: false, reason: 'binding_missing', binding: null, template: null }
  }
  const where = {
    id: binding.templateId,
    companyId,
    isEnabled: true,
    status: messages.whatsappApprovedTemplateStatus,
  }
  if (wabaId) {
    where.wabaId = wabaId
  }
  const template = await WhatsAppTemplate.findOne({ where })
  if (!template) {
    return { ok: false, reason: 'template_not_approved', binding, template: null }
  }
  if (isForbiddenWorkflowTemplateName(template.name)) {
    return { ok: false, reason: 'sample_template_forbidden', binding, template }
  }
  return { ok: true, reason: 'bound', binding, template }
}

/**
 * Public workflow status for Integration UI (no secrets).
 *
 * @param {string} companyId
 * @param {object} presentedConfig
 */
async function buildWorkflowStatus(companyId, presentedConfig) {
  const empty = (enabled) => ({
    enabled: Boolean(enabled),
    bindingPresent: false,
    templateApproved: false,
    templateName: null,
    templateLanguage: null,
    ready: false,
    reason: enabled ? 'binding_missing' : 'workflow_disabled',
  })

  if (!companyId) {
    return {
      metaAssign: empty(false),
      transfer: empty(false),
    }
  }

  const messagingReady = Boolean(presentedConfig && presentedConfig.messagingReady)
  const wabaId = presentedConfig && presentedConfig.wabaId ? presentedConfig.wabaId : null

  async function one(workflowKey, enabled) {
    if (!enabled) {
      return empty(false)
    }
    if (!messagingReady) {
      return {
        enabled: true,
        bindingPresent: false,
        templateApproved: false,
        templateName: null,
        templateLanguage: null,
        ready: false,
        reason: 'whatsapp_not_ready',
      }
    }
    const resolved = await resolveBoundTemplate(companyId, workflowKey, wabaId)
    if (!resolved.ok) {
      return {
        enabled: true,
        bindingPresent: Boolean(resolved.binding),
        templateApproved: false,
        templateName: resolved.template ? resolved.template.name : null,
        templateLanguage: resolved.template ? resolved.template.language : null,
        ready: false,
        reason: resolved.reason,
      }
    }
    return {
      enabled: true,
      bindingPresent: true,
      templateApproved: true,
      templateName: resolved.template.name,
      templateLanguage: resolved.template.language,
      ready: true,
      reason: 'ready',
    }
  }

  return {
    metaAssign: await one(
      whatsappWorkflowKeys.metaAssign,
      Boolean(presentedConfig && presentedConfig.metaAssignEnabled),
    ),
    transfer: await one(
      whatsappWorkflowKeys.transfer,
      Boolean(presentedConfig && presentedConfig.transferEnabled),
    ),
  }
}

/**
 * Enqueues primary-agent WhatsApp for W1 (meta_assign) or W2 (transfer).
 * Fail-soft: never throws to lead create/transfer callers.
 *
 * @param {object} details
 * @returns {Promise<{ queued: boolean, reason?: string, created?: boolean, outboxId?: string|null }>}
 */
async function deliverLeadPrimaryWhatsApp(details) {
  if (!details || typeof details !== 'object') {
    return { queued: false, reason: 'invalid_details' }
  }
  if (!details.companyId || !details.newPrimaryAgentId || !details.leadId) {
    return { queued: false, reason: 'missing_ids' }
  }

  const workflowKey = resolveWorkflowKey(details)
  if (!shouldQueueForWorkflow(details, workflowKey)) {
    logSkip(details, 'unchanged_or_unassigned')
    return { queued: false, reason: 'unchanged_or_unassigned' }
  }

  const { WhatsAppCompanyConfig, User } = getModels()
  const config = await WhatsAppCompanyConfig.findOne({
    where: { companyId: details.companyId },
  })
  if (
    !config
    || !config.isActive
    || !config.tokenStored
    || !config.wabaId
    || !config.phoneNumberId
  ) {
    logSkip(details, 'whatsapp_not_ready')
    return { queued: false, reason: 'whatsapp_not_ready' }
  }
  if (config.phoneRegistrationStatus !== whatsappPhoneRegistrationStatuses.registered) {
    logSkip(details, 'whatsapp_not_ready')
    return { queued: false, reason: 'whatsapp_not_ready' }
  }

  if (workflowKey === whatsappWorkflowKeys.metaAssign) {
    if (!config.metaAssignEnabled) {
      logSkip(details, 'workflow_disabled')
      return { queued: false, reason: 'workflow_disabled' }
    }
  } else if (workflowKey === whatsappWorkflowKeys.transfer) {
    if (!config.transferEnabled) {
      logSkip(details, 'workflow_disabled')
      return { queued: false, reason: 'workflow_disabled' }
    }
  } else {
    logSkip(details, 'unsupported_workflow')
    return { queued: false, reason: 'unsupported_workflow' }
  }

  const resolved = await resolveBoundTemplate(details.companyId, workflowKey, config.wabaId)
  if (!resolved.ok) {
    logSkip(details, resolved.reason)
    return { queued: false, reason: resolved.reason }
  }
  // Fail closed if bound template placeholders are not fully mapped.
  const placeholderCount = countBodyPlaceholders(resolved.template.components)
  const mappedKeys = Array.isArray(resolved.template.bodyVariableKeys)
    ? resolved.template.bodyVariableKeys
    : []
  if (mappedKeys.length !== placeholderCount) {
    logSkip(details, 'variable_keys_invalid')
    return { queued: false, reason: 'variable_keys_invalid' }
  }

  const agent = await User.findOne({
    where: {
      id: details.newPrimaryAgentId,
      companyId: details.companyId,
      status: userStatuses.active,
    },
    attributes: ['id', 'name', 'phone', 'companyId', 'status'],
  })
  if (!agent) {
    logSkip(details, 'agent_unavailable')
    return { queued: false, reason: 'agent_unavailable' }
  }

  const recipientPhone = normalizePhone(agent.phone || '')
  if (!isInternationalPhone(recipientPhone)) {
    logSkip(details, 'agent_phone_missing')
    return { queued: false, reason: 'agent_phone_missing' }
  }

  const context = buildAssignmentContext({
    leadSnapshot: details.leadSnapshot || {
      name: details.contactName,
      phone: details.contactNumber,
      campaignName: details.campaignName,
      facebookPageName: details.facebookPageName,
      pageName: details.pageName,
    },
    leadId: details.leadId,
    agent: { name: agent.name, phone: recipientPhone },
  })
  const mapped = mapBodyVariableKeys(resolved.template.bodyVariableKeys || [], context)
  if (!mapped.ok) {
    logSkip(details, mapped.reason, { missingKey: mapped.missingKey || '' })
    return { queued: false, reason: mapped.reason }
  }

  let idempotencyKey = details.idempotencyKey
    ? String(details.idempotencyKey).trim().slice(0, 191)
    : ''
  if (!idempotencyKey) {
    if (workflowKey === whatsappWorkflowKeys.transfer) {
      if (!details.transferId) {
        logSkip(details, 'missing_transfer_id')
        return { queued: false, reason: 'missing_transfer_id' }
      }
      idempotencyKey = buildTransferIdempotencyKey({
        companyId: details.companyId,
        leadId: details.leadId,
        transferId: details.transferId,
        primaryAgentId: details.newPrimaryAgentId,
      })
    } else {
      idempotencyKey = buildMetaAssignIdempotencyKey({
        companyId: details.companyId,
        leadId: details.leadId,
        primaryAgentId: details.newPrimaryAgentId,
      })
    }
  }

  const auth = {
    companyId: details.companyId,
    userId: details.actorUserId || details.newPrimaryAgentId,
  }

  try {
    const queued = await enqueueWhatsAppMessage(auth, {
      recipientPhone,
      recipientType: 'primary_agent',
      templateId: resolved.template.id,
      parameters: mapped.parameters,
      idempotencyKey,
      workflowKey,
    })
    console.info(JSON.stringify({
      event: 'whatsapp_assignment_enqueued',
      companyId: String(details.companyId),
      leadId: String(details.leadId),
      workflowKey,
      outboxId: queued.outboxId || '',
    }))
    return {
      queued: true,
      created: true,
      outboxId: queued.outboxId || null,
      messageLogId: queued.messageLogId || null,
      reason: 'created',
    }
  } catch (error) {
    if (
      error instanceof AppError
      && (error.statusCode === 409 || error.message === errors.whatsappIdempotencyConflict)
    ) {
      console.info(JSON.stringify({
        event: 'whatsapp_assignment_idempotent',
        companyId: String(details.companyId),
        leadId: String(details.leadId),
        workflowKey,
      }))
      return { queued: true, created: false, reason: 'idempotent', outboxId: null }
    }
    throw error
  }
}

/**
 * Non-blocking fail-soft entry used by createLead / assignLead.
 *
 * @param {object} details
 * @returns {Promise<{ queued: boolean, reason?: string }>}
 */
async function notifyLeadPrimaryWhatsApp(details) {
  try {
    return await deliverLeadPrimaryWhatsApp(details)
  } catch (error) {
    console.error(JSON.stringify({
      event: 'whatsapp_assignment_failed',
      companyId: details && details.companyId ? String(details.companyId) : '',
      leadId: details && details.leadId ? String(details.leadId) : '',
      workflowKey: details && details.workflowKey ? String(details.workflowKey) : '',
      message: sanitizeLogMessage(error),
    }))
    return { queued: false, reason: 'error' }
  }
}

/**
 * Fire-and-forget wrapper so lead HTTP responses are not delayed by enqueue I/O.
 *
 * @param {object} details
 */
function queueLeadPrimaryWhatsApp(details) {
  setImmediate(() => {
    notifyLeadPrimaryWhatsApp(details).catch(() => {})
  })
}

module.exports = {
  buildAssignmentContext,
  buildCrmLeadLink,
  buildMetaAssignIdempotencyKey,
  buildTransferIdempotencyKey,
  buildWorkflowStatus,
  deliverLeadPrimaryWhatsApp,
  mapBodyVariableKeys,
  notifyLeadPrimaryWhatsApp,
  queueLeadPrimaryWhatsApp,
  readFrontendBaseSoft,
  resolveBoundTemplate,
  resolveWorkflowKey,
}
