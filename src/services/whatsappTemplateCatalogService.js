const { v4: uuidv4 } = require('uuid')
const { security } = require('../config/security')
const { readWhatsAppGraphVersion } = require('../config/whatsappEnv')
const { getModels } = require('../models')
const {
  whatsappAuditActions,
  whatsappAuditOutcomes,
  whatsappTemplateVariableKeys,
  whatsappWorkflowKeys,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const { isUuid } = require('../utils/helpers')
const { listWhatsAppMessageTemplates } = require('./whatsappCloudClient')
const { writeWhatsAppAudit, sanitizeAuditDetail } = require('./whatsappAuditService')
const {
  findCompanyConfig,
  presentWhatsAppConfigForApi,
  readDecryptedAccessToken,
} = require('./whatsappConfigService')
const { assertActiveConnection } = require('./whatsappRegistrationService')

const ALLOWED_VARIABLE_KEYS = new Set(whatsappTemplateVariableKeys)
const ALLOWED_WORKFLOW_KEYS = new Set(Object.values(whatsappWorkflowKeys))

/**
 * Meta connectivity sample — allowed for Test Message only, never W1/W2.
 * @param {unknown} name
 * @returns {boolean}
 */
function isForbiddenWorkflowTemplateName(name) {
  return String(name || '').trim().toLowerCase() === 'hello_world'
}

/**
 * Extracts ordered BODY placeholders from Meta template components.
 * Supports positional {{1}} and named {{var_name}} tokens.
 *
 * @param {object[]} components
 * @returns {{ placeholders: string[], parameterFormat: string }}
 */
function extractBodyPlaceholders(components) {
  const placeholders = []
  const seen = new Set()
  if (!Array.isArray(components)) {
    return { placeholders, parameterFormat: '' }
  }
  for (const component of components) {
    if (!component || String(component.type || '').toUpperCase() !== 'BODY') {
      continue
    }
    const text = typeof component.text === 'string' ? component.text : ''
    const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)
    for (const match of matches) {
      const token = String(match[1] || '').trim()
      if (!token || seen.has(token)) continue
      seen.add(token)
      placeholders.push(token)
    }
  }
  const positional = placeholders.length > 0 && placeholders.every((item) => /^\d+$/.test(item))
  return {
    placeholders,
    parameterFormat: positional ? 'positional' : (placeholders.length ? 'named' : ''),
  }
}

function readQualityScore(row) {
  if (!row || row.quality_score == null) return null
  if (typeof row.quality_score === 'string') return row.quality_score.slice(0, 32)
  if (typeof row.quality_score === 'object' && row.quality_score.score != null) {
    return String(row.quality_score.score).slice(0, 32)
  }
  return null
}

function normalizeMetaTemplateRow(row) {
  const name = row && row.name ? String(row.name).trim() : ''
  const language = row && row.language ? String(row.language).trim() : ''
  if (!name || !language) {
    return null
  }
  const components = Array.isArray(row.components) ? row.components : []
  const extracted = extractBodyPlaceholders(components)
  return {
    metaId: row.id ? String(row.id).slice(0, 64) : null,
    name: name.slice(0, 120),
    language: language.slice(0, 16),
    category: row.category ? String(row.category).slice(0, 64) : null,
    status: row.status ? String(row.status).trim().toUpperCase().slice(0, 32) : 'PENDING',
    quality: readQualityScore(row),
    rejectionReason: row.rejected_reason
      ? String(row.rejected_reason).slice(0, 500)
      : (row.rejection_reason ? String(row.rejection_reason).slice(0, 500) : null),
    components,
    placeholderCount: extracted.placeholders.length,
    parameterFormat: row.parameter_format
      ? String(row.parameter_format).slice(0, 32)
      : extracted.parameterFormat,
  }
}

function presentTemplate(row) {
  if (!row) return null
  const extracted = extractBodyPlaceholders(row.components)
  return {
    id: row.id,
    wabaId: row.wabaId,
    metaId: row.metaId || null,
    name: row.name,
    language: row.language,
    category: row.category || null,
    status: row.status,
    quality: row.quality || null,
    rejectionReason: row.rejectionReason || null,
    bodyVariableKeys: Array.isArray(row.bodyVariableKeys) ? row.bodyVariableKeys : [],
    placeholderCount: extracted.placeholders.length,
    placeholders: extracted.placeholders,
    isEnabled: Boolean(row.isEnabled),
    lastSyncedAt: row.lastSyncedAt || null,
    updatedAt: row.updatedAt || null,
  }
}

function presentBinding(row, template) {
  return {
    workflowKey: row.workflowKey,
    templateId: row.templateId || null,
    template: template ? presentTemplate(template) : null,
  }
}

function validateBodyVariableKeys(rawKeys, expectedCount) {
  if (!Array.isArray(rawKeys)) {
    throw new AppError(errors.whatsappTemplateVariablesInvalid, 400)
  }
  const max = Number(security.whatsappTemplateMaxBodyVariables) || 20
  if (rawKeys.length > max) {
    throw new AppError(errors.whatsappTemplateVariablesInvalid, 400)
  }
  if (typeof expectedCount === 'number' && expectedCount >= 0 && rawKeys.length !== expectedCount) {
    throw new AppError(errors.whatsappTemplateVariablesInvalid, 400)
  }
  const keys = []
  for (const item of rawKeys) {
    const key = typeof item === 'string' ? item.trim() : ''
    if (!key || !ALLOWED_VARIABLE_KEYS.has(key)) {
      throw new AppError(errors.whatsappTemplateVariablesInvalid, 400)
    }
    keys.push(key)
  }
  return keys
}

/**
 * Syncs the connected WABA message template catalog from Meta.
 * Incomplete syncs do not mark unseen templates as deleted.
 *
 * @param {object} auth
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function syncCompanyTemplates(auth, meta = {}) {
  const config = await findCompanyConfig(auth)
  assertActiveConnection(config)

  let accessToken = null
  try {
    accessToken = readDecryptedAccessToken(config)
    const listed = await listWhatsAppMessageTemplates({
      accessToken,
      wabaId: config.wabaId,
      graphVersion: readWhatsAppGraphVersion(),
    })

    const { WhatsAppTemplate } = getModels()
    const now = new Date()
    let upserted = 0
    let created = 0
    const seenKeys = new Set()

    for (const raw of listed.templates) {
      const normalized = normalizeMetaTemplateRow(raw)
      if (!normalized) continue
      const identityKey = `${normalized.name}::${normalized.language}`
      seenKeys.add(identityKey)

      const existing = await WhatsAppTemplate.findOne({
        where: {
          companyId: auth.companyId,
          wabaId: config.wabaId,
          name: normalized.name,
          language: normalized.language,
        },
      })

      if (existing) {
        existing.metaId = normalized.metaId
        existing.category = normalized.category
        existing.status = normalized.status
        existing.quality = normalized.quality
        existing.rejectionReason = normalized.rejectionReason
        existing.components = normalized.components
        existing.lastSyncedAt = now
        // Preserve isEnabled and bodyVariableKeys on update.
        await existing.save()
        upserted += 1
      } else {
        await WhatsAppTemplate.create({
          id: uuidv4(),
          companyId: auth.companyId,
          wabaId: config.wabaId,
          metaId: normalized.metaId,
          name: normalized.name,
          language: normalized.language,
          category: normalized.category,
          status: normalized.status,
          quality: normalized.quality,
          rejectionReason: normalized.rejectionReason,
          components: normalized.components,
          bodyVariableKeys: [],
          lastSyncedAt: now,
          isEnabled: false,
        })
        created += 1
        upserted += 1
      }
    }

    let markedMissing = 0
    if (listed.complete) {
      const existingRows = await WhatsAppTemplate.findAll({
        where: {
          companyId: auth.companyId,
          wabaId: config.wabaId,
        },
      })
      for (const row of existingRows) {
        const key = `${row.name}::${row.language}`
        if (seenKeys.has(key)) continue
        row.status = 'DELETED'
        row.isEnabled = false
        row.lastSyncedAt = now
        await row.save()
        markedMissing += 1
      }
    }

    config.templatesLastSyncedAt = now
    config.templatesSyncError = ''
    config.updatedBy = auth.userId
    await config.save()

    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.templateSync,
      target: config.wabaId,
      outcome: whatsappAuditOutcomes.success,
      ip: meta.ip,
      requestId: meta.requestId,
      detail: sanitizeAuditDetail(JSON.stringify({
        upserted,
        created,
        markedMissing,
        pagesFetched: listed.pagesFetched,
        complete: listed.complete,
      })),
    })

    return {
      message: messages.whatsappTemplatesSynced,
      sync: {
        upserted,
        created,
        markedMissing,
        pagesFetched: listed.pagesFetched,
        complete: listed.complete,
        templatesLastSyncedAt: config.templatesLastSyncedAt,
      },
      config: await presentWhatsAppConfigForApi(config, auth.companyId),
    }
  } catch (error) {
    const detail = sanitizeAuditDetail(error.message || errors.whatsappTemplateSyncFailed).slice(0, 500)
    try {
      config.templatesSyncError = detail
      config.updatedBy = auth.userId
      await config.save()
    } catch {
      // ignore secondary save failure
    }
    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.templateSync,
      target: config.wabaId || 'templates',
      outcome: whatsappAuditOutcomes.failure,
      ip: meta.ip,
      requestId: meta.requestId,
      detail,
    }).catch(() => {})
    if (error instanceof AppError) {
      throw error
    }
    throw new AppError(errors.whatsappTemplateSyncFailed, 502)
  } finally {
    accessToken = null
  }
}

/**
 * @param {object} auth
 * @param {{ status?: string, enabled?: string }} [query]
 */
async function listCompanyTemplates(auth, query = {}) {
  const config = await findCompanyConfig(auth)
  const { WhatsAppTemplate } = getModels()
  const where = { companyId: auth.companyId }
  if (config && config.wabaId) {
    where.wabaId = config.wabaId
  }
  if (query.status) {
    where.status = String(query.status).trim().toUpperCase()
  }
  if (query.enabled === '1' || query.enabled === 'true') {
    where.isEnabled = true
  } else if (query.enabled === '0' || query.enabled === 'false') {
    where.isEnabled = false
  }

  const rows = await WhatsAppTemplate.findAll({
    where,
    order: [['name', 'ASC'], ['language', 'ASC']],
  })
  return {
    templates: rows.map(presentTemplate),
    templatesLastSyncedAt: config ? config.templatesLastSyncedAt || null : null,
    templatesSyncError: config ? config.templatesSyncError || '' : '',
    allowedVariableKeys: [...whatsappTemplateVariableKeys],
  }
}

/**
 * Updates local enablement and/or CRM body variable mapping.
 *
 * @param {object} auth
 * @param {string} templateId
 * @param {object} body
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function updateCompanyTemplate(auth, templateId, body, meta = {}) {
  if (!isUuid(templateId)) {
    throw new AppError(errors.whatsappTemplateNotFound, 404)
  }
  const config = await findCompanyConfig(auth)
  assertActiveConnection(config)
  const { WhatsAppTemplate } = getModels()
  const template = await WhatsAppTemplate.findOne({
    where: {
      id: templateId,
      companyId: auth.companyId,
      wabaId: config.wabaId,
    },
  })
  if (!template) {
    throw new AppError(errors.whatsappTemplateNotFound, 404)
  }

  const extracted = extractBodyPlaceholders(template.components)
  let nextKeys = Array.isArray(template.bodyVariableKeys) ? [...template.bodyVariableKeys] : []
  let touched = false

  if (Object.prototype.hasOwnProperty.call(body || {}, 'bodyVariableKeys')) {
    nextKeys = validateBodyVariableKeys(body.bodyVariableKeys, extracted.placeholders.length)
    template.bodyVariableKeys = nextKeys
    touched = true
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, 'isEnabled')) {
    if (typeof body.isEnabled !== 'boolean') {
      throw new AppError(errors.whatsappConfigInvalid, 400)
    }
    if (body.isEnabled) {
      if (template.status !== messages.whatsappApprovedTemplateStatus) {
        throw new AppError(errors.whatsappTemplateEnableInvalid, 400)
      }
      if (nextKeys.length !== extracted.placeholders.length) {
        throw new AppError(errors.whatsappTemplateEnableInvalid, 400)
      }
    }
    template.isEnabled = body.isEnabled
    touched = true
  }

  if (!touched) {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }

  await template.save()
  await writeWhatsAppAudit({
    companyId: auth.companyId,
    actorUserId: auth.userId,
    action: whatsappAuditActions.templateUpdate,
    target: template.id,
    outcome: whatsappAuditOutcomes.success,
    ip: meta.ip,
    requestId: meta.requestId,
    detail: sanitizeAuditDetail(JSON.stringify({
      name: template.name,
      language: template.language,
      isEnabled: template.isEnabled,
      bodyVariableKeys: template.bodyVariableKeys,
    })),
  })

  return {
    message: messages.whatsappTemplateUpdated,
    template: presentTemplate(template),
  }
}

/**
 * @param {object} auth
 */
async function listWorkflowBindings(auth) {
  const config = await findCompanyConfig(auth)
  const { WhatsAppWorkflowBinding, WhatsAppTemplate } = getModels()
  const rows = await WhatsAppWorkflowBinding.findAll({
    where: { companyId: auth.companyId },
  })
  const byKey = new Map(rows.map((row) => [row.workflowKey, row]))
  const result = []
  for (const workflowKey of [whatsappWorkflowKeys.metaAssign, whatsappWorkflowKeys.transfer]) {
    const binding = byKey.get(workflowKey) || null
    let template = null
    if (binding) {
      template = await WhatsAppTemplate.findOne({
        where: {
          id: binding.templateId,
          companyId: auth.companyId,
        },
      })
    }
    result.push({
      workflowKey,
      templateId: binding ? binding.templateId : null,
      template: presentTemplate(template),
      workflowEnabled: workflowKey === whatsappWorkflowKeys.metaAssign
        ? Boolean(config && config.metaAssignEnabled)
        : Boolean(config && config.transferEnabled),
    })
  }
  return { bindings: result }
}

/**
 * Upserts or clears a workflow binding after the assignment transaction-safe validation.
 *
 * @param {object} auth
 * @param {string} workflowKey
 * @param {{ templateId?: string|null }} body
 * @param {{ ip?: string, requestId?: string }} [meta]
 */
async function upsertWorkflowBinding(auth, workflowKey, body, meta = {}) {
  const key = String(workflowKey || '').trim()
  if (!ALLOWED_WORKFLOW_KEYS.has(key)) {
    throw new AppError(errors.whatsappWorkflowKeyInvalid, 400)
  }

  const config = await findCompanyConfig(auth)
  assertActiveConnection(config)
  const { WhatsAppWorkflowBinding, WhatsAppTemplate } = getModels()

  if (!Object.prototype.hasOwnProperty.call(body || {}, 'templateId')) {
    throw new AppError(errors.whatsappConfigInvalid, 400)
  }

  if (body.templateId === null || body.templateId === '') {
    const existing = await WhatsAppWorkflowBinding.findOne({
      where: { companyId: auth.companyId, workflowKey: key },
    })
    if (existing) {
      await existing.destroy()
    }
    await writeWhatsAppAudit({
      companyId: auth.companyId,
      actorUserId: auth.userId,
      action: whatsappAuditActions.workflowBinding,
      target: key,
      outcome: whatsappAuditOutcomes.success,
      ip: meta.ip,
      requestId: meta.requestId,
      detail: 'Cleared workflow template binding.',
    })
    return {
      message: messages.whatsappWorkflowBindingCleared,
      binding: {
        workflowKey: key,
        templateId: null,
        template: null,
      },
      config: await presentWhatsAppConfigForApi(config, auth.companyId),
    }
  }

  const templateId = String(body.templateId || '').trim()
  if (!isUuid(templateId)) {
    throw new AppError(errors.whatsappTemplateNotBindable, 400)
  }

  const template = await WhatsAppTemplate.findOne({
    where: {
      id: templateId,
      companyId: auth.companyId,
      wabaId: config.wabaId,
      isEnabled: true,
      status: messages.whatsappApprovedTemplateStatus,
    },
  })
  if (!template) {
    throw new AppError(errors.whatsappTemplateNotBindable, 400)
  }
  if (isForbiddenWorkflowTemplateName(template.name)) {
    throw new AppError(errors.whatsappWorkflowSampleTemplateForbidden, 400)
  }
  const extracted = extractBodyPlaceholders(template.components)
  const keys = Array.isArray(template.bodyVariableKeys) ? template.bodyVariableKeys : []
  if (keys.length !== extracted.placeholders.length) {
    throw new AppError(errors.whatsappTemplateNotBindable, 400)
  }
  validateBodyVariableKeys(keys, extracted.placeholders.length)

  let binding = await WhatsAppWorkflowBinding.findOne({
    where: { companyId: auth.companyId, workflowKey: key },
  })
  if (binding) {
    binding.templateId = template.id
    await binding.save()
  } else {
    binding = await WhatsAppWorkflowBinding.create({
      id: uuidv4(),
      companyId: auth.companyId,
      workflowKey: key,
      templateId: template.id,
    })
  }

  await writeWhatsAppAudit({
    companyId: auth.companyId,
    actorUserId: auth.userId,
    action: whatsappAuditActions.workflowBinding,
    target: key,
    outcome: whatsappAuditOutcomes.success,
    ip: meta.ip,
    requestId: meta.requestId,
    detail: sanitizeAuditDetail(JSON.stringify({
      templateId: template.id,
      templateName: template.name,
      language: template.language,
    })),
  })

  return {
    message: messages.whatsappWorkflowBindingSaved,
    binding: presentBinding(binding, template),
    config: await presentWhatsAppConfigForApi(config, auth.companyId),
  }
}

module.exports = {
  extractBodyPlaceholders,
  isForbiddenWorkflowTemplateName,
  normalizeMetaTemplateRow,
  presentTemplate,
  syncCompanyTemplates,
  listCompanyTemplates,
  updateCompanyTemplate,
  listWorkflowBindings,
  upsertWorkflowBinding,
  validateBodyVariableKeys,
}
