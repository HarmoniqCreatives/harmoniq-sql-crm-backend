'use strict'

const ExcelJS = require('exceljs')
const { AppError, errors } = require('../utils/errors')
const {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_NOTES_COUNT,
  FIELD_LABELS,
  HEADER_SYNONYMS,
  IMPORT_FIELDS,
} = require('./leadImportConstants')

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * Auto-maps Excel headers to CRM fields using synonyms only.
 * Unknown headers stay null (Skip) — never mapped to an unrelated field.
 *
 * @param {string[]} headers
 * @returns {Record<string, string|null>}
 */
function suggestMapping(headers) {
  const mapping = {}
  const usedFields = new Set()
  for (const header of headers) {
    const normalized = normalizeHeader(header)
    let matched = null
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
      if (usedFields.has(field)) continue
      if (synonyms.includes(normalized) || normalizeHeader(FIELD_LABELS[field]) === normalized) {
        matched = field
        break
      }
    }
    mapping[header] = matched
    if (matched) usedFields.add(matched)
  }
  return mapping
}

/**
 * Mapping confidence for UI (exact / synonym / none). Never invents medium-confidence guesses.
 *
 * @param {string} header
 * @param {string|null} field
 */
function mappingConfidence(header, field) {
  if (!field) return 'none'
  const normalized = normalizeHeader(header)
  const label = FIELD_LABELS[field] || field
  if (normalizeHeader(label) === normalized) return 'exact'
  const synonyms = HEADER_SYNONYMS[field] || []
  if (synonyms.includes(normalized)) return 'synonym'
  return 'none'
}

/**
 * Explains why each header was suggested (or left as Skip).
 *
 * @param {string[]} headers
 * @param {Record<string, string|null>} mapping
 * @returns {Record<string, string>}
 */
function explainSuggestedMapping(headers, mapping) {
  const reasons = {}
  for (const header of headers) {
    const field = mapping?.[header] || null
    if (!field) {
      reasons[header] = 'No matching CRM field. Leave as Skip unless you choose a field manually.'
      continue
    }
    const label = FIELD_LABELS[field] || field
    const confidence = mappingConfidence(header, field)
    if (confidence === 'exact') {
      reasons[header] = `Exact match for CRM field "${label}".`
      continue
    }
    if (confidence === 'synonym') {
      reasons[header] = `Suggested because "${header}" matches known labels for "${label}".`
      continue
    }
    reasons[header] = `Suggested CRM field "${label}".`
  }
  return reasons
}

/**
 * @param {string[]} headers
 * @param {Record<string, string|null>} mapping
 */
function mappingConfidenceMap(headers, mapping) {
  const out = {}
  for (const header of headers || []) {
    out[header] = mappingConfidence(header, mapping?.[header] || null)
  }
  return out
}

function cellToPlainValue(cell) {
  if (!cell || cell.value === null || cell.value === undefined) {
    return ''
  }
  const raw = cell.value
  if (raw && typeof raw === 'object') {
    if (Object.prototype.hasOwnProperty.call(raw, 'result')) {
      return cellToPlainValue({ value: raw.result })
    }
    if (raw instanceof Date) {
      return raw
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'text')) {
      return String(raw.text || '').trim()
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'richText')) {
      return (raw.richText || []).map((part) => part.text || '').join('').trim()
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'hyperlink') && Object.prototype.hasOwnProperty.call(raw, 'text')) {
      return String(raw.text || '').trim()
    }
  }
  if (raw instanceof Date) {
    return raw
  }
  if (typeof raw === 'number' && cell.numFmt && /[dy]/i.test(String(cell.numFmt))) {
    return raw
  }
  return String(raw).trim()
}

function assertWorkbookBuffer(buffer, meta = {}) {
  const size = Number(meta.fileSizeBytes || (buffer && buffer.length) || 0)
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(errors.leadImportFileRequired, 400)
  }
  if (size > IMPORT_MAX_FILE_BYTES || buffer.length > IMPORT_MAX_FILE_BYTES) {
    throw new AppError(errors.leadImportFileTooLarge, 400)
  }
  const filename = String(meta.originalFilename || '').toLowerCase()
  if (filename && !filename.endsWith('.xlsx')) {
    throw new AppError(errors.leadImportFileTypeInvalid, 400)
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new AppError(errors.leadImportFileInvalid, 400)
  }
}

/**
 * Score a candidate header row by how many cells match known import synonyms.
 * Used only as a suggestion — never auto-selected when ambiguous without user choice.
 *
 * @param {import('exceljs').Worksheet} sheet
 * @param {number} rowNumber
 */
function scoreHeaderRow(sheet, rowNumber) {
  const row = sheet.getRow(rowNumber)
  let score = 0
  let cells = 0
  row.eachCell({ includeEmpty: false }, (cell) => {
    const header = String(cellToPlainValue(cell) || '').trim()
    if (!header) return
    cells += 1
    const normalized = normalizeHeader(header)
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
      if (synonyms.includes(normalized) || normalizeHeader(FIELD_LABELS[field]) === normalized) {
        score += 1
        break
      }
    }
  })
  return { rowNumber, score, cells }
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function buildSheetsMeta(workbook) {
  return workbook.worksheets.map((sheet, index) => {
    const lastRow = Math.min(sheet.actualRowCount || sheet.rowCount || 1, 30)
    const candidates = []
    for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
      const scored = scoreHeaderRow(sheet, rowNumber)
      if (scored.cells >= 2) {
        candidates.push(scored)
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.rowNumber - b.rowNumber)
    const suggestedHeaderRow = candidates[0]?.score > 0 ? candidates[0].rowNumber : 1
    return {
      index,
      name: sheet.name || `Sheet ${index + 1}`,
      rowCount: sheet.actualRowCount || sheet.rowCount || 0,
      suggestedHeaderRow,
      headerCandidates: candidates.slice(0, 5).map((row) => ({
        rowNumber: row.rowNumber,
        matchScore: row.score,
        cellCount: row.cells,
      })),
    }
  })
}

/**
 * Inspect worksheets without committing to a parse selection.
 *
 * @param {Buffer} buffer
 * @param {{ originalFilename?: string, fileSizeBytes?: number }} meta
 */
async function inspectWorkbookBuffer(buffer, meta = {}) {
  assertWorkbookBuffer(buffer, meta)
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch (_error) {
    throw new AppError(errors.leadImportFileInvalid, 400)
  }
  if (!workbook.worksheets.length) {
    throw new AppError(errors.leadImportFileInvalid, 400)
  }
  return { sheets: buildSheetsMeta(workbook) }
}

/**
 * Reads headers from a sheet row; duplicates get " (2)", " (3)" suffixes so values stay addressable.
 *
 * @param {import('exceljs').Worksheet} sheet
 * @param {number} headerRowNumber
 */
function readHeaders(sheet, headerRowNumber) {
  const headerRow = sheet.getRow(headerRowNumber)
  const headers = []
  const colIndexByHeader = {}
  const seen = new Map()
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    let header = String(cellToPlainValue(cell) || '').trim()
    if (!header) return
    const base = header
    const count = (seen.get(base) || 0) + 1
    seen.set(base, count)
    if (count > 1) {
      header = `${base} (${count})`
    }
    headers.push(header)
    colIndexByHeader[header] = colNumber
  })
  return { headers, colIndexByHeader }
}

/**
 * Parses an .xlsx buffer into headers + row objects.
 * Defaults: first worksheet, header row 1. Caller may select sheet/header explicitly.
 *
 * @param {Buffer} buffer
 * @param {{
 *   originalFilename?: string,
 *   mimeType?: string,
 *   fileSizeBytes?: number,
 *   sheetIndex?: number,
 *   headerRow?: number,
 * }} meta
 */
async function parseWorkbookBuffer(buffer, meta = {}) {
  assertWorkbookBuffer(buffer, meta)

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch (_error) {
    throw new AppError(errors.leadImportFileInvalid, 400)
  }
  if (!workbook.worksheets.length) {
    throw new AppError(errors.leadImportFileInvalid, 400)
  }

  const sheets = buildSheetsMeta(workbook)
  const sheetIndex = Number.isInteger(Number(meta.sheetIndex))
    ? Number(meta.sheetIndex)
    : 0
  if (sheetIndex < 0 || sheetIndex >= workbook.worksheets.length) {
    throw new AppError('Select a valid worksheet for this Excel file.', 400)
  }
  const sheet = workbook.worksheets[sheetIndex]
  if (!sheet) {
    throw new AppError(errors.leadImportFileInvalid, 400)
  }

  const headerRow = Number.isInteger(Number(meta.headerRow)) && Number(meta.headerRow) > 0
    ? Number(meta.headerRow)
    : (sheets[sheetIndex]?.suggestedHeaderRow || 1)

  const { headers, colIndexByHeader } = readHeaders(sheet, headerRow)
  if (headers.length === 0) {
    throw new AppError('No column headers found on the selected header row. Choose another header row.', 400)
  }

  const rows = []
  const lastRow = sheet.actualRowCount || sheet.rowCount || headerRow
  for (let rowNumber = headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const values = {}
    let hasAny = false
    for (const header of headers) {
      const col = colIndexByHeader[header]
      const value = cellToPlainValue(row.getCell(col))
      values[header] = value
      if (value !== '' && value !== null && value !== undefined) {
        hasAny = true
      }
    }
    if (!hasAny) continue
    rows.push({
      excelRowNumber: rowNumber,
      values,
    })
    if (rows.length > IMPORT_MAX_ROWS) {
      throw new AppError(errors.leadImportRowLimit, 400)
    }
  }

  const suggestedMapping = suggestMapping(headers)
  return {
    headers,
    suggestedMapping,
    suggestionReasons: explainSuggestedMapping(headers, suggestedMapping),
    mappingConfidence: mappingConfidenceMap(headers, suggestedMapping),
    rows,
    rowCount: rows.length,
    sheetIndex,
    sheetName: sheet.name || `Sheet ${sheetIndex + 1}`,
    headerRow,
    sheets,
  }
}

/**
 * Builds the downloadable CRM Excel template (values only, no fake CRM records).
 */
async function buildImportTemplateBuffer() {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'FILOS CRM'
  const sheet = workbook.addWorksheet('Leads Import')
  const columns = Object.keys(IMPORT_FIELDS).map((field) => FIELD_LABELS[field])
  sheet.addRow(columns)
  sheet.getRow(1).font = { bold: true }
  sheet.addRow([
    'Example Contact',
    '+971500000000',
    '+971500000001',
    'example@email.com',
    'manual',
    '',
    '',
    'New',
    '',
    '25-11-2026 10:00:00',
    '',
    '',
    '',
    '',
    '',
    '',
    ...Array.from({ length: IMPORT_NOTES_COUNT * 3 }, () => ''),
  ].slice(0, columns.length))

  const help = workbook.addWorksheet('Instructions')
  help.addRow(['FILOS CRM — Lead Excel Import Instructions'])
  help.getRow(1).font = { bold: true }
  help.addRow([])
  help.addRow(['Limits', 'Max 10 MB, max 5,000 data rows, .xlsx only'])
  help.addRow(['Phone', 'Prefer E.164 with + (e.g. +971501234567). Local numbers may use the company timezone/currency dial code when unambiguous.'])
  help.addRow(['Lead Source', 'Allowed values: manual, facebook, instagram, website. Other labels require explicit value mapping.'])
  help.addRow(['Status', 'Must match an active Status name in your company catalog, or be mapped during import.'])
  help.addRow(['Assigned Agent', 'Must match exactly one active user name in your company, or be mapped during import.'])
  help.addRow(['Tags', 'Comma-separated tag names that exist in your company catalog, or be mapped during import.'])
  help.addRow(['Received On', 'Excel date cell, or DD-MM-YYYY HH:mm:ss, or DD-MM-YYYY hh:mm:ss AM/PM'])
  help.addRow(['Notes', 'Lead note 1–10 each create a separate lead history note. Skip unused note columns. Empty notes are not imported.'])
  help.addRow(['Duplicates', 'Matching phones require Manual Review (Skip / Update Existing / Import as New)'])
  help.addRow(['Skip', 'Unmapped Excel columns are skipped and do not cause Invalid rows.'])
  help.addRow([])
  help.addRow(['Column', 'CRM field'])
  for (const field of Object.keys(IMPORT_FIELDS)) {
    help.addRow([FIELD_LABELS[field], field])
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

module.exports = {
  normalizeHeader,
  suggestMapping,
  explainSuggestedMapping,
  mappingConfidence,
  mappingConfidenceMap,
  cellToPlainValue,
  inspectWorkbookBuffer,
  parseWorkbookBuffer,
  buildImportTemplateBuffer,
}
