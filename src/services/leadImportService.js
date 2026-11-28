'use strict'

const { randomBytes } = require('crypto')
const { v4: uuidv4 } = require('uuid')
const ExcelJS = require('exceljs')
const { getModels } = require('../models')
const { AppError, errors } = require('../utils/errors')
const {
  leadEntryMethods,
  leadImportDecisions,
  leadImportSessionStatuses,
  permissionKeys,
} = require('../utils/enums')
const { hasPermission } = require('./accessService')
const leadService = require('./leadService')
const {
  parseWorkbookBuffer,
  buildImportTemplateBuffer,
  explainSuggestedMapping,
  mappingConfidenceMap,
} = require('./leadImportParseService')
const {
  parseImportDate,
  resolvePhone,
  loadCompanyResolutionMaps,
  extractNotes,
  resolveNoteAuthors,
  findLeadsByPhones,
  isEmail,
} = require('./leadImportResolveService')
const {
  IMPORT_FIELDS,
  FIELD_LABELS,
  REQUIRED_IMPORT_FIELDS,
  describeImportField,
} = require('./leadImportConstants')
const {
  buildValueMappingWorkspace,
  normalizeValueMappings,
  applySingleValueMap,
  applyTagValueMaps,
  headerFingerprint,
} = require('./leadImportValueMapService')

function presentSession(session, { includeRows = false } = {}) {
  const plain = typeof session.toJSON === 'function' ? session.toJSON() : session
  const summary = plain.validationSummaryJson || null
  // Never echo raw sourceRows in API payloads (kept only for server-side revalidate).
  const publicSummary = summary
    ? (() => {
      const { sourceRows: _sourceRows, ...rest } = summary
      return rest
    })()
    : null
  const out = {
    id: plain.id,
    status: plain.status,
    originalFilename: plain.originalFilename,
    fileSizeBytes: plain.fileSizeBytes,
    rowCount: plain.rowCount,
    headers: plain.headersJson || [],
    mapping: plain.mappingJson || null,
    suggestedMapping: publicSummary?.suggestedMapping || null,
    validationSummary: publicSummary,
    parseOptions: publicSummary?.parseOptions || null,
    sheets: publicSummary?.sheets || [],
    valueMappings: publicSummary?.valueMappings || null,
    valueMappingWorkspace: publicSummary?.valueMappingWorkspace || null,
    headerFingerprint: publicSummary?.headerFingerprint || null,
    results: plain.resultsJson || null,
    errorMessage: plain.errorMessage || null,
    confirmToken: plain.status === leadImportSessionStatuses.validated ? plain.confirmToken : undefined,
    completedAt: plain.completedAt || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  }
  if (includeRows) {
    out.rows = plain.rowsJson || []
  }
  return out
}

async function getSessionForAuth(auth, sessionId) {
  const { LeadImportSession } = getModels()
  const session = await LeadImportSession.findOne({
    where: {
      id: String(sessionId || ''),
      companyId: auth.companyId,
    },
  })
  if (!session) {
    throw new AppError(errors.leadImportSessionNotFound, 404)
  }
  return session
}

async function downloadTemplate() {
  const buffer = await buildImportTemplateBuffer()
  return {
    buffer,
    filename: 'melo-lead-import-template.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
}

/**
 * @param {object} auth
 * @param {object} file multer file
 * @param {{ sheetIndex?: number, headerRow?: number }} [options]
 */
async function createSession(auth, file, options = {}) {
  if (!hasPermission(auth, permissionKeys.leadsImport)) {
    throw new AppError(errors.forbidden, 403)
  }
  if (!hasPermission(auth, permissionKeys.leadsCreate)) {
    throw new AppError(errors.leadImportPermissionCreate, 403)
  }
  if (!file || !file.buffer) {
    throw new AppError(errors.leadImportFileRequired, 400)
  }
  const parsed = await parseWorkbookBuffer(file.buffer, {
    originalFilename: file.originalname,
    mimeType: file.mimetype,
    fileSizeBytes: file.size,
    sheetIndex: options.sheetIndex,
    headerRow: options.headerRow,
  })

  const fingerprint = headerFingerprint(parsed.headers)
  const suggestionReasons = parsed.suggestionReasons
    || explainSuggestedMapping(parsed.headers, parsed.suggestedMapping)
  const confidence = parsed.mappingConfidence
    || mappingConfidenceMap(parsed.headers, parsed.suggestedMapping)

  const { LeadImportSession } = getModels()
  const session = await LeadImportSession.create({
    id: uuidv4(),
    companyId: auth.companyId,
    userId: auth.userId,
    originalFilename: String(file.originalname || 'import.xlsx').slice(0, 255),
    fileSizeBytes: Number(file.size || file.buffer.length),
    mimeType: file.mimetype || null,
    status: leadImportSessionStatuses.uploaded,
    rowCount: parsed.rowCount,
    headersJson: parsed.headers,
    mappingJson: parsed.suggestedMapping,
    rowsJson: parsed.rows,
    validationSummaryJson: {
      suggestedMapping: parsed.suggestedMapping,
      suggestionReasons,
      mappingConfidence: confidence,
      totalRows: parsed.rowCount,
      sheets: parsed.sheets,
      parseOptions: {
        sheetIndex: parsed.sheetIndex,
        sheetName: parsed.sheetName,
        headerRow: parsed.headerRow,
      },
      headerFingerprint: fingerprint,
      valueMappings: normalizeValueMappings({}),
      sourceRows: parsed.rows,
    },
    decisionsJson: null,
    resultsJson: null,
    errorMessage: null,
    idempotencyKey: null,
    confirmToken: null,
    completedAt: null,
  })

  return {
    session: presentSession(session),
    suggestedMapping: parsed.suggestedMapping,
    suggestionReasons,
    mappingConfidence: confidence,
    sheets: parsed.sheets,
    parseOptions: {
      sheetIndex: parsed.sheetIndex,
      sheetName: parsed.sheetName,
      headerRow: parsed.headerRow,
    },
    headerFingerprint: fingerprint,
    fieldLabels: FIELD_LABELS,
    fields: Object.keys(IMPORT_FIELDS),
    requiredFields: REQUIRED_IMPORT_FIELDS,
    fieldMeta: Object.fromEntries(
      Object.keys(IMPORT_FIELDS).map((field) => [field, describeImportField(field)]),
    ),
  }
}

function isSkippedMappingTarget(field) {
  return !field || field === 'ignore' || field === 'skip'
}

function applyMapping(row, mapping) {
  const mapped = {}
  for (const [header, field] of Object.entries(mapping || {})) {
    if (isSkippedMappingTarget(field)) continue
    if (!Object.prototype.hasOwnProperty.call(IMPORT_FIELDS, field)) continue
    mapped[field] = row.values[header]
  }
  return mapped
}

function fieldToExcelColumn(mapping) {
  const out = {}
  for (const [header, field] of Object.entries(mapping || {})) {
    if (isSkippedMappingTarget(field)) continue
    if (!Object.prototype.hasOwnProperty.call(IMPORT_FIELDS, field)) continue
    out[field] = header
  }
  return out
}

function formatValidationError({ column, message, value }) {
  const parts = []
  if (column) parts.push(`[${column}]`)
  parts.push(message)
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    const clipped = String(value).trim().slice(0, 80)
    parts.push(`(value: "${clipped}")`)
  }
  return parts.join(' ')
}

function pushRowError(rowErrors, errorDetails, detail) {
  const text = formatValidationError(detail)
  rowErrors.push(text)
  errorDetails.push({
    field: detail.field || null,
    column: detail.column || null,
    value: detail.value === undefined || detail.value === null
      ? null
      : String(detail.value).slice(0, 120),
    message: detail.message,
  })
}

function pushReviewIssue(reviewIssues, reviewDetails, detail) {
  const text = formatValidationError(detail)
  reviewIssues.push(text)
  reviewDetails.push({
    field: detail.field || null,
    column: detail.column || null,
    value: detail.value === undefined || detail.value === null
      ? null
      : String(detail.value).slice(0, 120),
    message: detail.message,
    kind: 'need_review',
  })
}

/**
 * Raw Excel rows for re-validation (mapping / value-map changes).
 * Kept in validationSummaryJson.sourceRows — no new DB columns.
 */
function getSourceRows(session) {
  const fromSummary = session.validationSummaryJson?.sourceRows
  if (Array.isArray(fromSummary) && fromSummary.length) return fromSummary
  const rows = session.rowsJson || []
  if (rows.length && rows[0]?.values) return rows
  return []
}

function groupErrorsByReason(invalidRows) {
  const groups = new Map()
  for (const row of invalidRows) {
    const details = row.errorDetails?.length
      ? row.errorDetails
      : (row.errors || []).map((message) => ({ message, field: null, column: null, value: null }))
    for (const detail of details) {
      const reason = detail.message || 'Validation failed'
      if (!groups.has(reason)) {
        groups.set(reason, { reason, count: 0, samples: [] })
      }
      const group = groups.get(reason)
      group.count += 1
      if (group.samples.length < 5) {
        group.samples.push({
          excelRowNumber: row.excelRowNumber,
          column: detail.column,
          value: detail.value,
        })
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

function validateMapping(mapping, headers) {
  if (!mapping || typeof mapping !== 'object') {
    throw new AppError(errors.leadImportMappingRequired, 400)
  }
  const headerSet = new Set(headers)
  let hasName = false
  let hasPhone = false
  let hasStatus = false
  for (const [header, field] of Object.entries(mapping)) {
    if (!headerSet.has(header)) continue
    if (isSkippedMappingTarget(field)) continue
    if (!Object.prototype.hasOwnProperty.call(IMPORT_FIELDS, field)) {
      throw new AppError(errors.leadImportMappingRequired, 400)
    }
    if (field === 'name') hasName = true
    if (field === 'phone') hasPhone = true
    if (field === 'status') hasStatus = true
  }
  if (!hasName || !hasPhone || !hasStatus) {
    throw new AppError(
      'Map at least Name, Contact No, and Status before validating.',
      400,
    )
  }
}

async function validateSession(auth, sessionId, body = {}) {
  if (!hasPermission(auth, permissionKeys.leadsImport)) {
    throw new AppError(errors.forbidden, 403)
  }
  const session = await getSessionForAuth(auth, sessionId)
  if (session.status === leadImportSessionStatuses.completed) {
    throw new AppError(errors.leadImportSessionCompleted, 409)
  }

  const mapping = body.mapping || session.mappingJson
  validateMapping(mapping, session.headersJson || [])

  const maps = await loadCompanyResolutionMaps(auth.companyId)
  const sourceRows = getSourceRows(session)
  if (!sourceRows.length) {
    throw new AppError('Import session has no source rows to validate. Upload the file again.', 400)
  }

  const valueMappings = normalizeValueMappings(
    body.valueMappings !== undefined
      ? body.valueMappings
      : session.validationSummaryJson?.valueMappings,
  )
  const valueMappingWorkspace = buildValueMappingWorkspace(sourceRows, mapping, maps)

  const phoneOwners = new Map()
  const validatedRows = []
  const duplicates = []
  const warnings = []
  const columnsByField = fieldToExcelColumn(mapping)
  const companyContext = maps.companyContext || {}
  const prior = session.validationSummaryJson || {}

  for (const row of sourceRows) {
    const mapped = applyMapping(row, mapping)
    const rowErrors = []
    const errorDetails = []
    const reviewIssues = []
    const reviewDetails = []
    const rowWarnings = []

    const name = mapped.name !== undefined && mapped.name !== null ? String(mapped.name).trim() : ''
    if (!name) {
      pushRowError(rowErrors, errorDetails, {
        field: 'name',
        column: columnsByField.name,
        value: mapped.name,
        message: 'Name is required',
      })
    }

    const phoneResult = resolvePhone(mapped.phone, { required: true, companyContext })
    if (!phoneResult.ok) {
      pushRowError(rowErrors, errorDetails, {
        field: 'phone',
        column: columnsByField.phone,
        value: mapped.phone,
        message: phoneResult.error,
      })
    }
    const altResult = resolvePhone(mapped.alternatePhone, { required: false, companyContext })
    if (!altResult.ok) {
      pushRowError(rowErrors, errorDetails, {
        field: 'alternatePhone',
        column: columnsByField.alternatePhone,
        value: mapped.alternatePhone,
        message: `Alternate: ${altResult.error}`,
      })
    }

    let email = ''
    if (mapped.email !== undefined && mapped.email !== null && String(mapped.email).trim() !== '') {
      email = String(mapped.email).trim().toLowerCase()
      if (!isEmail(email)) {
        pushRowError(rowErrors, errorDetails, {
          field: 'email',
          column: columnsByField.email,
          value: mapped.email,
          message: 'Email is invalid',
        })
      }
    }

    const sourceResult = applySingleValueMap('source', mapped.source, valueMappings, maps)
    if (sourceResult.needReview) {
      pushReviewIssue(reviewIssues, reviewDetails, {
        field: 'source',
        column: columnsByField.source,
        value: mapped.source,
        message: sourceResult.message,
      })
    }

    const statusResult = applySingleValueMap('status', mapped.status, valueMappings, maps)
    if (statusResult.empty) {
      pushRowError(rowErrors, errorDetails, {
        field: 'status',
        column: columnsByField.status,
        value: mapped.status,
        message: 'Status is required',
      })
    } else if (statusResult.needReview) {
      pushReviewIssue(reviewIssues, reviewDetails, {
        field: 'status',
        column: columnsByField.status,
        value: mapped.status,
        message: statusResult.message,
      })
    }

    let agent = null
    if (mapped.assignedAgent !== undefined && String(mapped.assignedAgent || '').trim() !== '') {
      const agentResult = applySingleValueMap('assignedAgent', mapped.assignedAgent, valueMappings, maps)
      if (agentResult.needReview) {
        pushReviewIssue(reviewIssues, reviewDetails, {
          field: 'assignedAgent',
          column: columnsByField.assignedAgent,
          value: mapped.assignedAgent,
          message: agentResult.message,
        })
      } else {
        agent = agentResult.value
      }
    }

    const tagResult = applyTagValueMaps(mapped.tags, valueMappings, maps)
    for (const tagMessage of tagResult.needReviewMessages || []) {
      pushReviewIssue(reviewIssues, reviewDetails, {
        field: 'tags',
        column: columnsByField.tags,
        value: mapped.tags,
        message: tagMessage,
      })
    }
    for (const tagError of tagResult.errorMessages || []) {
      pushRowError(rowErrors, errorDetails, {
        field: 'tags',
        column: columnsByField.tags,
        value: mapped.tags,
        message: tagError,
      })
    }

    const received = parseImportDate(mapped.receivedOn)
    if (mapped.receivedOn !== undefined && mapped.receivedOn !== null && String(mapped.receivedOn).trim() !== '' && !received.ok) {
      pushRowError(rowErrors, errorDetails, {
        field: 'receivedOn',
        column: columnsByField.receivedOn,
        value: mapped.receivedOn,
        message: 'Received On is invalid',
      })
    }

    let notes = extractNotes(mapped)
    const noteErrors = notes.filter((n) => n.error)
    for (const n of noteErrors) {
      pushRowError(rowErrors, errorDetails, {
        field: `note${n.index}AddedOn`,
        column: columnsByField[`note${n.index}AddedOn`],
        value: mapped[`note${n.index}AddedOn`],
        message: n.error,
      })
    }
    notes = resolveNoteAuthors(
      notes.filter((n) => !n.error),
      maps.userByName,
      auth.userId,
    )
    for (const n of notes) {
      if (n.authorWarning) rowWarnings.push(n.authorWarning)
    }

    const phone = phoneResult.value
    if (phone) {
      if (!phoneOwners.has(phone)) phoneOwners.set(phone, [])
      phoneOwners.get(phone).push(row.excelRowNumber)
    }

    const prepared = {
      excelRowNumber: row.excelRowNumber,
      mapped,
      name,
      phone,
      alternatePhone: altResult.value,
      email,
      source: sourceResult.value || null, // manual when empty; null when Need Review
      subSource: mapped.subSource ? String(mapped.subSource).trim().slice(0, 120) : null,
      agencyName: mapped.agencyName ? String(mapped.agencyName).trim().slice(0, 200) : null,
      statusReason: mapped.statusReason ? String(mapped.statusReason).trim().slice(0, 300) : null,
      statusId: statusResult.value ? statusResult.value.id : null,
      statusName: statusResult.value ? statusResult.value.name : null,
      primaryAgentId: agent ? agent.id : null,
      primaryAgentName: agent ? agent.name : null,
      tagIds: tagResult.ids,
      receivedOn: received.date,
      facebookPageName: mapped.facebookPageName ? String(mapped.facebookPageName).trim().slice(0, 255) : '',
      facebookAdName: mapped.facebookAdName ? String(mapped.facebookAdName).trim().slice(0, 255) : '',
      facebookAdSetName: mapped.facebookAdSetName ? String(mapped.facebookAdSetName).trim().slice(0, 255) : '',
      facebookCampaignName: mapped.facebookCampaignName ? String(mapped.facebookCampaignName).trim().slice(0, 255) : '',
      notes,
      errors: rowErrors,
      errorDetails,
      reviewIssues,
      reviewDetails,
      warnings: rowWarnings,
      duplicate: null,
    }

    if (rowWarnings.length) {
      warnings.push({
        excelRowNumber: row.excelRowNumber,
        warnings: rowWarnings,
      })
    }
    validatedRows.push(prepared)
  }

  // CRM duplicates by primary phone (loaded once, then merged with Excel-internal groups).
  const crmLeads = await findLeadsByPhones(
    auth.companyId,
    validatedRows.map((row) => row.phone).filter(Boolean),
  )
  applyDuplicateReviewFlags(validatedRows, phoneOwners, crmLeads)

  for (const prepared of validatedRows) {
    if (!prepared.duplicate?.requiresDecision) continue
    duplicates.push({
      excelRowNumber: prepared.excelRowNumber,
      phone: prepared.phone,
      type: prepared.duplicate.type,
      excelRows: prepared.duplicate.excelRows || [],
      excelGroup: prepared.duplicate.excelGroup || [],
      matches: prepared.duplicate.matches || [],
      actions: prepared.duplicate.actions || [],
      warning: prepared.duplicate.warning || '',
    })
    if (prepared.duplicate.warning) {
      prepared.warnings.push(prepared.duplicate.warning)
      warnings.push({
        excelRowNumber: prepared.excelRowNumber,
        warnings: [prepared.duplicate.warning],
      })
    }
  }

  const invalidRows = validatedRows.filter(
    (row) => row.errors.length > 0 && !row.duplicate?.requiresDecision && !(row.reviewIssues || []).length,
  )
  const needsReview = validatedRows.filter(
    (row) => row.duplicate?.requiresDecision || (row.reviewIssues || []).length > 0,
  )
  const validRows = validatedRows.filter(
    (row) => row.errors.length === 0
      && !(row.reviewIssues || []).length
      && !row.duplicate?.requiresDecision,
  )

  const catalogNeedReview = validatedRows.filter((row) => (row.reviewIssues || []).length > 0)

  const summary = {
    totalRows: validatedRows.length,
    validRows: validRows.length,
    invalidRows: invalidRows.length,
    duplicateRows: validatedRows.filter((row) => row.duplicate?.requiresDecision).length,
    needReviewRows: needsReview.length,
    catalogNeedReviewRows: catalogNeedReview.length,
    warningRows: warnings.length,
    suggestedMapping: prior.suggestedMapping || null,
    suggestionReasons: prior.suggestionReasons || null,
    mappingConfidence: prior.mappingConfidence || null,
    sheets: prior.sheets || [],
    parseOptions: prior.parseOptions || null,
    headerFingerprint: prior.headerFingerprint || headerFingerprint(session.headersJson || []),
    valueMappings,
    valueMappingWorkspace,
    sourceRows,
    companyDialCode: maps.dialCode || '',
    invalid: invalidRows.map((row) => ({
      excelRowNumber: row.excelRowNumber,
      errors: row.errors,
      errorDetails: row.errorDetails || [],
    })),
    needReview: needsReview.map((row) => ({
      excelRowNumber: row.excelRowNumber,
      errors: row.errors,
      errorDetails: row.errorDetails || [],
      reviewIssues: row.reviewIssues || [],
      reviewDetails: row.reviewDetails || [],
      duplicate: row.duplicate,
    })),
    errorsByReason: groupErrorsByReason([
      ...invalidRows,
      ...catalogNeedReview.filter((row) => row.errors.length === 0),
    ].map((row) => ({
      ...row,
      errorDetails: [
        ...(row.errorDetails || []),
        ...(row.reviewDetails || []),
      ],
      errors: [...(row.errors || []), ...(row.reviewIssues || [])],
    }))),
    duplicates,
    internalExcelDuplicateGroups: buildInternalExcelDuplicateGroups(phoneOwners),
    warnings,
  }

  session.mappingJson = mapping
  session.rowsJson = validatedRows
  session.validationSummaryJson = summary
  session.status = leadImportSessionStatuses.validated
  session.confirmToken = randomBytes(16).toString('hex')
  session.errorMessage = null
  await session.save()

  return {
    session: presentSession(session),
    valueMappings,
    valueMappingWorkspace,
    rows: validatedRows.map((row) => ({
      excelRowNumber: row.excelRowNumber,
      name: row.name,
      phone: row.phone,
      statusName: row.statusName,
      primaryAgentName: row.primaryAgentName,
      errors: row.errors,
      reviewIssues: row.reviewIssues || [],
      reviewDetails: row.reviewDetails || [],
      warnings: row.warnings,
      duplicate: row.duplicate,
      notesCount: row.notes.length,
      proposed: {
        statusId: row.statusId,
        primaryAgentId: row.primaryAgentId,
        tagIds: row.tagIds,
        source: row.source,
        receivedOn: row.receivedOn,
      },
    })),
  }
}

/**
 * Marks rows that need Manual Review for Excel-internal and/or CRM phone collisions.
 * Internal Excel duplicates are warnings + decisions — never hard validation rejects.
 *
 * @param {object[]} validatedRows
 * @param {Map<string, number[]>} phoneOwners excelRowNumbers by normalized phone
 * @param {object[]} crmLeads
 */
function applyDuplicateReviewFlags(validatedRows, phoneOwners, crmLeads) {
  const crmByPhone = new Map()
  for (const lead of crmLeads || []) {
    const key = lead.phone
    if (!crmByPhone.has(key)) crmByPhone.set(key, [])
    const isDeleted = Boolean(lead.deletedAt)
    crmByPhone.get(key).push({
      id: lead.id,
      number: lead.number,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      statusId: lead.statusId,
      primaryAgentId: lead.primaryAgentId,
      deletedAt: lead.deletedAt || null,
      is_deleted: isDeleted,
      isDeleted,
    })
  }

  for (const prepared of validatedRows) {
    if (!prepared.phone) continue
    const excelGroup = phoneOwners.get(prepared.phone) || []
    const excelInternal = excelGroup.length > 1
    const matches = crmByPhone.get(prepared.phone) || []
    const hasCrm = matches.length > 0
    if (!excelInternal && !hasCrm) continue

    const activeMatches = matches.filter((m) => !m.isDeleted)
    const deletedMatches = matches.filter((m) => m.isDeleted)
    const excelRows = excelGroup.filter((n) => n !== prepared.excelRowNumber)

    let type = 'crm'
    if (excelInternal && hasCrm) type = 'crm_and_excel_internal'
    else if (excelInternal) type = 'excel_internal'
    else if (activeMatches.length === 0 && deletedMatches.length > 0) type = 'crm_soft_deleted'
    else if (matches.length > 1) type = 'crm_multiple'

    const actions = [leadImportDecisions.skip, leadImportDecisions.importAsNew]
    if (activeMatches.length > 0) {
      actions.splice(1, 0, leadImportDecisions.updateExisting)
    }
    if (deletedMatches.length > 0) {
      const insertAt = actions.indexOf(leadImportDecisions.importAsNew)
      actions.splice(insertAt, 0, leadImportDecisions.restoreExisting)
    }

    let warning = ''
    if (type === 'excel_internal') {
      warning = `Contact No is duplicated within this Excel file (rows ${excelGroup.join(', ')}). Choose Skip or Import as New for each row.`
    } else if (type === 'crm_soft_deleted') {
      warning = 'Contact No matches a soft-deleted CRM lead. Choose Restore Existing, Skip, or explicitly Import as New — it will not be imported silently as a new lead.'
    } else if (type === 'crm_and_excel_internal') {
      warning = `Contact No matches CRM lead(s) and is also duplicated in this Excel file (rows ${excelGroup.join(', ')}). Choose Skip, Update/Restore Existing, or Import as New.`
    } else if (matches.length > 1) {
      warning = 'Multiple CRM leads share this phone (including soft-deleted). Select one lead before Update/Restore Existing, or explicitly Import as New.'
    } else {
      warning = 'A CRM lead already uses this phone. Choose Skip, Update Existing, or Import as New.'
    }

    prepared.duplicate = {
      type,
      matches,
      activeMatches,
      deletedMatches,
      excelRows,
      excelGroup: [...excelGroup],
      requiresDecision: true,
      requiresLeadSelection: matches.length > 1,
      actions,
      warning,
    }
  }
}

function buildInternalExcelDuplicateGroups(phoneOwners) {
  const groups = []
  for (const [phone, rows] of phoneOwners.entries()) {
    if (rows.length < 2) continue
    groups.push({ phone, excelRows: [...rows].sort((a, b) => a - b) })
  }
  return groups
}

function hardValidationErrors(row) {
  return [...(row.errors || []), ...(row.reviewIssues || [])].filter(Boolean)
}

function assertConfirmDecisions(validatedRows, decisions) {
  const byRow = new Map()
  for (const item of decisions || []) {
    byRow.set(Number(item.excelRowNumber), item)
  }
  for (const row of validatedRows) {
    const unresolvedReview = (row.reviewIssues || []).length > 0
    if (unresolvedReview && !row.duplicate?.requiresDecision) {
      throw new AppError(
        `Excel row ${row.excelRowNumber} still needs value mapping (Status, Source, Agent, or Tags) before import.`,
        400,
      )
    }
    if (!row.duplicate?.requiresDecision) continue
    const hardErrors = hardValidationErrors(row)
    if (hardErrors.length) {
      throw new AppError(
        `Excel row ${row.excelRowNumber} still has validation errors and cannot be imported.`,
        400,
      )
    }
    const decision = byRow.get(row.excelRowNumber)
    if (!decision || !decision.action) {
      throw new AppError(errors.leadImportDecisionsRequired, 400)
    }
    const action = String(decision.action)
    const allowed = row.duplicate.actions || [
      leadImportDecisions.skip,
      leadImportDecisions.updateExisting,
      leadImportDecisions.importAsNew,
    ]
    if (!allowed.includes(action)) {
      throw new AppError(errors.leadImportDecisionInvalid, 400)
    }
    if (action === leadImportDecisions.updateExisting) {
      const activeIds = (row.duplicate.activeMatches || row.duplicate.matches || [])
        .filter((m) => !m.isDeleted)
        .map((m) => m.id)
      const selected = decision.existingLeadId
      if (!activeIds.length) {
        throw new AppError(
          `Excel row ${row.excelRowNumber}: Update Existing is only available for active CRM leads. Use Restore Existing for soft-deleted matches.`,
          400,
        )
      }
      if (!selected || !activeIds.includes(selected)) {
        throw new AppError(
          `Excel row ${row.excelRowNumber}: select an active matching CRM lead for Update Existing.`,
          400,
        )
      }
    }
    if (action === leadImportDecisions.restoreExisting) {
      const deletedIds = (row.duplicate.deletedMatches || row.duplicate.matches || [])
        .filter((m) => m.isDeleted)
        .map((m) => m.id)
      const selected = decision.existingLeadId
      if (!deletedIds.length) {
        throw new AppError(
          `Excel row ${row.excelRowNumber}: Restore Existing is only available when a soft-deleted CRM lead matches.`,
          400,
        )
      }
      if (!selected || !deletedIds.includes(selected)) {
        throw new AppError(
          `Excel row ${row.excelRowNumber}: select a soft-deleted matching CRM lead to restore.`,
          400,
        )
      }
    }
    if (action === leadImportDecisions.importAsNew && decision.confirmImportAsNew !== true) {
      throw new AppError(
        `Excel row ${row.excelRowNumber}: confirm Import as New explicitly.`,
        400,
      )
    }
  }
  return byRow
}

async function appendImportedNotes(auth, leadId, notes, transaction) {
  const { LeadNote } = getModels()
  for (const note of notes) {
    const createdAt = note.addedOn && !Number.isNaN(new Date(note.addedOn).getTime())
      ? new Date(note.addedOn)
      : new Date()
    await LeadNote.create({
      id: uuidv4(),
      companyId: auth.companyId,
      leadId,
      text: note.text,
      createdBy: note.createdBy || auth.userId,
      authorDisplayName: note.authorDisplayName || null,
      createdAt,
      updatedAt: createdAt,
    }, { transaction })
  }
}

async function mergeTags(auth, leadId, tagIds, transaction) {
  if (!tagIds || tagIds.length === 0) return
  const { LeadTag } = getModels()
  const existing = await LeadTag.findAll({
    where: { companyId: auth.companyId, leadId },
    transaction,
  })
  const have = new Set(existing.map((row) => row.tagId))
  for (const tagId of tagIds) {
    if (have.has(tagId)) continue
    await LeadTag.create({
      id: uuidv4(),
      companyId: auth.companyId,
      leadId,
      tagId,
    }, { transaction })
  }
}

function buildCreateBody(row) {
  return {
    name: row.name,
    phone: row.phone,
    email: row.email || '',
    source: row.source,
    statusId: row.statusId,
    primaryAgentId: row.primaryAgentId || undefined,
    tagIds: row.tagIds || [],
    campaignName: row.facebookCampaignName || '',
    adName: row.facebookAdName || '',
    adSetName: row.facebookAdSetName || '',
    facebookPageName: row.facebookPageName || '',
    alternatePhone: row.alternatePhone || null,
    subSource: row.subSource || null,
    agencyName: row.agencyName || null,
    statusReason: row.statusReason || null,
    receivedOn: row.receivedOn || null,
  }
}

/**
 * Restore a soft-deleted lead (paranoid) then apply blank-safe Excel update.
 * @param {object} auth
 * @param {string} leadId
 * @param {object} row
 */
async function restoreLeadAndApplyImport(auth, leadId, row) {
  await leadService.restoreLead(auth, leadId, { allowWithoutRecyclePermission: true })
  return applyBlankSafeUpdate(auth, leadId, row)
}

async function applyBlankSafeUpdate(auth, leadId, row) {
  const { sequelize, Lead } = getModels()
  const lead = await leadService.findLeadInScope(auth, leadId)

  // Preserve original origin — never overwrite entryMethod / importSessionId / importedAt.
  const patch = {}
  if (row.name) patch.name = row.name
  if (row.email) patch.email = row.email
  if (row.source) patch.source = row.source
  if (row.alternatePhone) patch.alternatePhone = row.alternatePhone
  if (row.subSource) patch.subSource = row.subSource
  if (row.agencyName) patch.agencyName = row.agencyName
  if (row.statusReason) patch.statusReason = row.statusReason
  if (row.receivedOn) patch.receivedOn = row.receivedOn
  if (row.facebookPageName) patch.facebookPageName = row.facebookPageName
  if (row.facebookAdName) patch.adName = row.facebookAdName
  if (row.facebookAdSetName) patch.adSetName = row.facebookAdSetName
  if (row.facebookCampaignName) patch.campaignName = row.facebookCampaignName
  if (row.statusId && row.statusId !== lead.statusId) {
    if (!hasPermission(auth, permissionKeys.leadsEdit)) {
      throw new AppError(errors.leadImportPermissionEdit, 403)
    }
    patch.statusId = row.statusId
  }

  await sequelize.transaction(async (transaction) => {
    if (Object.keys(patch).length) {
      Object.assign(lead, patch)
      // Re-assert immutable provenance in case of accidental mass-assign later.
      // (patch intentionally omits origin fields.)
      await lead.save({ transaction })
    }
    await mergeTags(auth, lead.id, row.tagIds || [], transaction)
    await appendImportedNotes(auth, lead.id, row.notes || [], transaction)
  })

  if (row.primaryAgentId && row.primaryAgentId !== lead.primaryAgentId) {
    if (!hasPermission(auth, permissionKeys.leadsAssign)) {
      throw new AppError(errors.leadImportPermissionAssign, 403)
    }
    await leadService.assignLead(auth, lead.id, {
      primaryAgentId: row.primaryAgentId,
      reason: 'Excel import update',
    }, { suppressNotifications: true })
  }

  return lead.id
}

/**
 * Require an exact confirmToken match before mutating CRM data.
 * Rejects missing/empty/non-string tokens on either side; never logs or returns the expected token.
 *
 * @param {object} body
 * @param {{ confirmToken?: string|null }} session
 */
function assertConfirmToken(body, session) {
  const supplied = body && Object.prototype.hasOwnProperty.call(body, 'confirmToken')
    ? body.confirmToken
    : undefined
  const expected = session ? session.confirmToken : undefined
  if (
    typeof supplied !== 'string'
    || supplied.length === 0
    || typeof expected !== 'string'
    || expected.length === 0
    || supplied !== expected
  ) {
    throw new AppError(errors.leadImportSessionNotReady, 400)
  }
}

async function confirmSession(auth, sessionId, body = {}) {
  if (!hasPermission(auth, permissionKeys.leadsImport)) {
    throw new AppError(errors.forbidden, 403)
  }
  const session = await getSessionForAuth(auth, sessionId)
  if (session.status === leadImportSessionStatuses.completed) {
    return {
      session: presentSession(session),
      idempotent: true,
      results: session.resultsJson,
    }
  }
  if (session.status !== leadImportSessionStatuses.validated) {
    throw new AppError(errors.leadImportSessionNotReady, 400)
  }
  assertConfirmToken(body, session)

  const validatedRows = session.rowsJson || []
  const decisionMap = assertConfirmDecisions(validatedRows, body.decisions || [])

  const succeeded = []
  const failed = []
  const skipped = []
  const assignmentSummary = new Map()

  for (const row of validatedRows) {
    try {
      const hardErrors = hardValidationErrors(row)
      const decision = decisionMap.get(row.excelRowNumber)

      if (row.duplicate?.requiresDecision) {
        if (!decision) {
          failed.push({ excelRowNumber: row.excelRowNumber, error: 'Missing duplicate decision' })
          continue
        }
        if (decision.action === leadImportDecisions.skip) {
          skipped.push({ excelRowNumber: row.excelRowNumber, action: 'skip' })
          continue
        }
        if (hardErrors.length) {
          failed.push({ excelRowNumber: row.excelRowNumber, error: hardErrors.join('; ') })
          continue
        }
        if (decision.action === leadImportDecisions.updateExisting) {
          if (!hasPermission(auth, permissionKeys.leadsEdit)) {
            throw new AppError(errors.leadImportPermissionEdit, 403)
          }
          const leadId = await applyBlankSafeUpdate(auth, decision.existingLeadId, row)
          succeeded.push({
            excelRowNumber: row.excelRowNumber,
            action: 'update_existing',
            leadId,
          })
          if (row.primaryAgentId) {
            const key = row.primaryAgentId
            if (!assignmentSummary.has(key)) {
              assignmentSummary.set(key, { primaryAgentId: key, name: row.primaryAgentName, count: 0 })
            }
            assignmentSummary.get(key).count += 1
          }
          continue
        }
        if (decision.action === leadImportDecisions.restoreExisting) {
          if (!hasPermission(auth, permissionKeys.leadsEdit)
            && !hasPermission(auth, permissionKeys.recycleBinRestore)) {
            throw new AppError(errors.leadImportPermissionEdit, 403)
          }
          const leadId = await restoreLeadAndApplyImport(auth, decision.existingLeadId, row)
          succeeded.push({
            excelRowNumber: row.excelRowNumber,
            action: 'restore_existing',
            leadId,
          })
          if (row.primaryAgentId) {
            const key = row.primaryAgentId
            if (!assignmentSummary.has(key)) {
              assignmentSummary.set(key, { primaryAgentId: key, name: row.primaryAgentName, count: 0 })
            }
            assignmentSummary.get(key).count += 1
          }
          continue
        }
        // import as new
      } else if (hardErrors.length) {
        failed.push({ excelRowNumber: row.excelRowNumber, error: hardErrors.join('; ') })
        continue
      }

      if (!hasPermission(auth, permissionKeys.leadsCreate)) {
        throw new AppError(errors.leadImportPermissionCreate, 403)
      }
      if (row.primaryAgentId && !hasPermission(auth, permissionKeys.leadsAssign) && row.primaryAgentId !== auth.userId) {
        // Creating with another agent requires assign permission
        if (!hasPermission(auth, permissionKeys.leadsAssign)) {
          throw new AppError(errors.leadImportPermissionAssign, 403)
        }
      }

      const created = await leadService.createLead(auth, buildCreateBody(row), {
        entryMethod: leadEntryMethods.excelImport,
        importSessionId: session.id,
        importedAt: session.completedAt ? new Date(session.completedAt) : new Date(),
        suppressAssignmentNotifications: true,
      })
      const leadId = created.lead.id
      const { sequelize } = getModels()
      await sequelize.transaction(async (transaction) => {
        await appendImportedNotes(auth, leadId, row.notes || [], transaction)
      })
      succeeded.push({
        excelRowNumber: row.excelRowNumber,
        action: row.duplicate?.requiresDecision ? 'import_as_new' : 'create',
        leadId,
        leadNumber: created.lead.number,
      })
      if (row.primaryAgentId) {
        const key = row.primaryAgentId
        if (!assignmentSummary.has(key)) {
          assignmentSummary.set(key, { primaryAgentId: key, name: row.primaryAgentName, count: 0 })
        }
        assignmentSummary.get(key).count += 1
      }
    } catch (error) {
      failed.push({
        excelRowNumber: row.excelRowNumber,
        error: error.message || 'Import failed',
      })
    }
  }

  const results = {
    succeededCount: succeeded.length,
    failedCount: failed.length,
    skippedCount: skipped.length,
    succeeded,
    failed,
    skipped,
    assignmentSummary: [...assignmentSummary.values()],
    message: `Import finished: ${succeeded.length} succeeded, ${failed.length} failed, ${skipped.length} skipped.`,
  }

  session.status = leadImportSessionStatuses.completed
  session.decisionsJson = body.decisions || []
  session.resultsJson = results
  session.completedAt = new Date()
  session.idempotencyKey = session.idempotencyKey || `confirm:${session.id}`
  session.confirmToken = null
  await session.save()

  // Consolidated import summary only — no per-row push/email fan-out.
  // assignmentSummary is returned to the client for display / future digest jobs.

  return {
    session: presentSession(session),
    idempotent: false,
    results,
  }
}

async function getSession(auth, sessionId) {
  if (!hasPermission(auth, permissionKeys.leadsImport)) {
    throw new AppError(errors.forbidden, 403)
  }
  const session = await getSessionForAuth(auth, sessionId)
  return {
    session: presentSession(session, { includeRows: session.status !== leadImportSessionStatuses.completed }),
  }
}

async function buildErrorReport(auth, sessionId) {
  if (!hasPermission(auth, permissionKeys.leadsImport)) {
    throw new AppError(errors.forbidden, 403)
  }
  const session = await getSessionForAuth(auth, sessionId)
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Import Errors')
  sheet.addRow(['Excel Row', 'Type', 'Column', 'Value', 'Detail'])
  sheet.getRow(1).font = { bold: true }

  const summary = session.validationSummaryJson || {}
  for (const row of summary.invalid || []) {
    const details = row.errorDetails?.length
      ? row.errorDetails
      : (row.errors || []).map((message) => ({ message, column: '', value: '' }))
    for (const detail of details) {
      sheet.addRow([
        row.excelRowNumber,
        'validation',
        detail.column || '',
        detail.value || '',
        detail.message || '',
      ])
    }
  }
  for (const row of summary.needReview || []) {
    const details = row.reviewDetails?.length
      ? row.reviewDetails
      : (row.reviewIssues || []).map((message) => ({ message, column: '', value: '' }))
    for (const detail of details) {
      sheet.addRow([
        row.excelRowNumber,
        'need_review',
        detail.column || '',
        detail.value || '',
        detail.message || '',
      ])
    }
    if (row.duplicate?.requiresDecision) {
      sheet.addRow([
        row.excelRowNumber,
        'duplicate',
        'Contact No',
        row.duplicate?.matches?.[0]?.phone || '',
        row.duplicate?.warning || 'Duplicate phone needs a decision',
      ])
    }
  }
  for (const row of summary.duplicates || []) {
    sheet.addRow([
      row.excelRowNumber,
      'duplicate',
      'Contact No',
      row.phone || '',
      `Phone ${row.phone} matches CRM lead(s): ${(row.matches || []).map((m) => `#${m.number} ${m.name}`).join(', ')}`,
    ])
  }
  const results = session.resultsJson || {}
  for (const row of results.failed || []) {
    sheet.addRow([row.excelRowNumber, 'failed', '', '', row.error])
  }
  for (const row of results.skipped || []) {
    sheet.addRow([row.excelRowNumber, 'skipped', '', '', row.action || 'skip'])
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  return {
    buffer,
    filename: `lead-import-errors-${session.id.slice(0, 8)}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
}

module.exports = {
  presentSession,
  downloadTemplate,
  createSession,
  validateSession,
  confirmSession,
  getSession,
  buildErrorReport,
  applyMapping,
  fieldToExcelColumn,
  formatValidationError,
  groupErrorsByReason,
  assertConfirmDecisions,
  assertConfirmToken,
  applyDuplicateReviewFlags,
  buildInternalExcelDuplicateGroups,
  hardValidationErrors,
}
