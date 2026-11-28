const ExcelJS = require('exceljs')
const { Op } = require('sequelize')
const { getModels } = require('../models')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const { readText } = require('../utils/helpers')
const {
  buildLeadQuery,
  presentLeads,
} = require('./leadService')

const UNKNOWN_PAGE = () => messages.dailyLeadEmailUnknownPageType

/**
 * Escapes a CSV cell (RFC-style quoting).
 * @param {unknown} value
 * @returns {string}
 */
function csvCell(value) {
  let text = ''
  if (value !== undefined && value !== null) {
    text = String(value)
  }
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`
  }
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * @param {object[]} rows presented leads
 * @returns {string}
 */
function toCsv(rows) {
  const headers = [
    messages.csvNumber,
    messages.csvName,
    messages.csvPhone,
    messages.csvEmail,
    messages.csvSource,
    messages.csvStatus,
    messages.csvTags,
    messages.csvPrimaryAgent,
    messages.csvSecondaryAgent,
    messages.csvPropertyType,
    messages.csvPurpose,
    messages.csvLocation,
    messages.csvBudget,
    messages.csvCurrency,
    messages.csvBuiltUpArea,
    messages.csvCarpetArea,
    messages.csvReadiness,
    messages.csvFollowUp,
    messages.csvCampaignName,
    messages.csvCampaignStatus,
    messages.csvPageName,
    messages.csvMetaCreatedAt,
    messages.csvCreatedAt,
    messages.csvAddedVia,
    messages.csvImportedAt,
    messages.csvImportBatchId,
  ]
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) {
    const cells = [
      row.label,
      row.name,
      row.phone,
      row.email,
      row.source,
      row.status ? row.status.name : '',
      (row.tags || []).map((tag) => tag.name).join('; '),
      row.primaryAgent ? row.primaryAgent.name : '',
      row.secondaryAgent ? row.secondaryAgent.name : '',
      row.propertyType,
      row.purpose,
      row.location,
      row.budget,
      row.currency,
      row.builtUpArea,
      row.carpetArea,
      row.readiness,
      row.nextFollowUpAt ? new Date(row.nextFollowUpAt).toISOString() : '',
      row.campaignName || '',
      row.campaignStatus || '',
      row.facebookPageName || messages.leadPageNotAvailable || 'Not Available',
      row.metaCreatedAt ? new Date(row.metaCreatedAt).toISOString() : '',
      row.createdAt ? new Date(row.createdAt).toISOString() : '',
      row.entryMethod || row.addedVia || '',
      row.importedAt ? new Date(row.importedAt).toISOString() : '',
      row.importSessionId || row.importBatchId || '',
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

/**
 * Converts a lead createdAt value to a real Date for Excel cells.
 * @param {Date|string|number|null|undefined} value
 * @returns {Date|null}
 */
function toLeadCreatedExcelDate(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date
}

/**
 * Builds an Excel workbook. Lead Created Date uses a real Excel date
 * formatted as yyyy-mm-dd hh:mm:ss (not the report generation time).
 *
 * @param {object[]} rows
 * @returns {Promise<Buffer>}
 */
async function toXlsx(rows) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Leads')
  sheet.columns = [
    { header: messages.csvNumber, key: 'label', width: 12 },
    { header: messages.csvName, key: 'name', width: 24 },
    { header: messages.csvPhone, key: 'phone', width: 18 },
    { header: messages.csvEmail, key: 'email', width: 28 },
    { header: messages.csvSource, key: 'source', width: 12 },
    { header: messages.csvStatus, key: 'status', width: 16 },
    { header: messages.csvTags, key: 'tags', width: 20 },
    { header: messages.csvPrimaryAgent, key: 'primary', width: 18 },
    { header: messages.csvSecondaryAgent, key: 'secondary', width: 18 },
    { header: messages.csvPropertyType, key: 'propertyType', width: 14 },
    { header: messages.csvPurpose, key: 'purpose', width: 10 },
    { header: messages.csvLocation, key: 'location', width: 20 },
    { header: messages.csvBudget, key: 'budget', width: 14 },
    { header: messages.csvCurrency, key: 'currency', width: 10 },
    { header: messages.csvBuiltUpArea, key: 'builtUpArea', width: 14 },
    { header: messages.csvCarpetArea, key: 'carpetArea', width: 14 },
    { header: messages.csvReadiness, key: 'readiness', width: 14 },
    { header: messages.csvFollowUp, key: 'followUp', width: 22 },
    { header: messages.csvCampaignName, key: 'campaign', width: 20 },
    { header: messages.csvCampaignStatus, key: 'campaignStatus', width: 14 },
    { header: messages.csvPageName, key: 'page', width: 22 },
    { header: messages.csvMetaCreatedAt, key: 'metaCreatedAt', width: 24 },
    { header: messages.csvCreatedAt, key: 'createdAt', width: 24 },
    { header: messages.csvAddedVia, key: 'addedVia', width: 14 },
    { header: messages.csvImportedAt, key: 'importedAt', width: 24 },
    { header: messages.csvImportBatchId, key: 'importBatchId', width: 38 },
  ]
  for (const row of rows) {
    const excelRow = sheet.addRow({
      label: row.label || '',
      name: row.name || '',
      phone: row.phone || '',
      email: row.email || '',
      source: row.source || '',
      status: row.status ? row.status.name : '',
      tags: (row.tags || []).map((tag) => tag.name).join('; '),
      primary: row.primaryAgent ? row.primaryAgent.name : '',
      secondary: row.secondaryAgent ? row.secondaryAgent.name : '',
      propertyType: row.propertyType || '',
      purpose: row.purpose || '',
      location: row.location || '',
      budget: row.budget || '',
      currency: row.currency || '',
      builtUpArea: row.builtUpArea || '',
      carpetArea: row.carpetArea || '',
      readiness: row.readiness || '',
      followUp: row.nextFollowUpAt ? new Date(row.nextFollowUpAt).toISOString() : '',
      campaign: row.campaignName || '',
      campaignStatus: row.campaignStatus || '',
      page: row.facebookPageName || messages.leadPageNotAvailable || 'Not Available',
      metaCreatedAt: toLeadCreatedExcelDate(row.metaCreatedAt),
      createdAt: toLeadCreatedExcelDate(row.createdAt),
      addedVia: row.entryMethod || row.addedVia || '',
      importedAt: toLeadCreatedExcelDate(row.importedAt),
      importBatchId: row.importSessionId || row.importBatchId || '',
    })
    for (const key of ['metaCreatedAt', 'createdAt', 'importedAt']) {
      const cell = excelRow.getCell(key)
      if (cell.value instanceof Date) {
        cell.numFmt = 'yyyy-mm-dd hh:mm:ss'
      }
    }
  }
  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

function readDateBoundary(value, { endOfDay = false } = {}) {
  const text = String(value || '').trim()
  if (!text) {
    return null
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) {
    throw new AppError(errors.reportDateRangeInvalid, 400)
  }
  return date
}

/**
 * Extends lead query with report date range + page type filter.
 * @param {object} auth
 * @param {object} query
 */
async function buildExportQuery(auth, query) {
  const built = await buildLeadQuery(auth, query)
  const and = Array.isArray(built.where[Op.and]) ? [...built.where[Op.and]] : []

  // Date range + pageType are applied in buildLeadQuery.
  if (and.length > 0) {
    built.where[Op.and] = and
  }
  return built
}

/**
 * Loads all matching leads (no pagination) inside the caller's scope.
 * @param {object} auth
 * @param {object} query
 */
async function loadExportLeads(auth, query) {
  const { Lead } = getModels()
  const { where, include } = await buildExportQuery(auth, query)
  const rows = await Lead.findAll({
    where,
    include,
    order: [['createdAt', 'ASC'], ['number', 'ASC']],
  })
  return presentLeads(auth, rows)
}

/**
 * @param {object} auth
 * @param {object} query
 * @returns {Promise<{ format: string, filename: string, contentType: string, body: string|Buffer, count: number }>}
 */
async function exportLeads(auth, query) {
  const format = String(readText(query, 'format') || 'csv').toLowerCase()
  if (format !== 'csv' && format !== 'xlsx') {
    throw new AppError(errors.reportFormatInvalid, 400)
  }
  const rows = await loadExportLeads(auth, query)
  const startLabel = String(query.startDate || query.from || 'all').slice(0, 10)
  const endLabel = String(query.endDate || query.to || 'all').slice(0, 10)
  const base = `Lead_Report_${startLabel}_to_${endLabel}`
  if (format === 'xlsx') {
    const body = await toXlsx(rows)
    return {
      format,
      filename: `${base}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body,
      count: rows.length,
    }
  }
  return {
    format: 'csv',
    filename: `${base}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: toCsv(rows),
    count: rows.length,
  }
}

/**
 * Distinct Facebook page names for filter dropdowns (plus Unknown when blanks exist).
 * @param {object} auth
 */
async function listLeadPageTypes(auth) {
  const { Lead } = getModels()
  const { where } = await buildLeadQuery(auth, {})
  const rows = await Lead.findAll({
    attributes: ['facebookPageName'],
    where,
    raw: true,
  })
  const names = new Set()
  let hasUnknown = false
  for (const row of rows) {
    const name = String(row.facebookPageName || '').trim()
    if (!name) {
      hasUnknown = true
    } else {
      names.add(name)
    }
  }
  const pageTypes = Array.from(names).sort((left, right) => left.localeCompare(right))
  if (hasUnknown) {
    pageTypes.push(UNKNOWN_PAGE())
  }
  return { pageTypes }
}

module.exports = {
  csvCell,
  toCsv,
  toXlsx,
  toLeadCreatedExcelDate,
  exportLeads,
  listLeadPageTypes,
  loadExportLeads,
  buildExportQuery,
  UNKNOWN_PAGE,
}
