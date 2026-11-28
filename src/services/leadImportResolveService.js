'use strict'

const { Op } = require('sequelize')
const { getModels } = require('../models')
const { catalogKinds, leadSources, userStatuses } = require('../utils/enums')
const { isEmail } = require('../utils/helpers')
const {
  normalizeMetaLeadPhone,
  resolveCompanyDialCode,
} = require('../utils/metaPhone')
const { SOURCE_LABEL_MAP, IMPORT_NOTES_COUNT } = require('./leadImportConstants')

function normalizePersonKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function parseImportDate(value) {
  if (value === null || value === undefined || value === '') return { ok: true, date: null }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, date: null }
    return { ok: true, date: value }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial date (days since 1899-12-30)
    const excelEpoch = Date.UTC(1899, 11, 30)
    const ms = excelEpoch + Math.round(value * 86400000)
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return { ok: false, date: null }
    return { ok: true, date }
  }
  const text = String(value).trim()
  if (!text) return { ok: true, date: null }

  const iso = new Date(text)
  if (!Number.isNaN(iso.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return { ok: true, date: iso }
  }

  // DD-MM-YYYY HH:mm:ss or DD-MM-YYYY hh:mm:ss AM/PM
  const match = text.match(
    /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?$/,
  )
  if (match) {
    const day = Number(match[1])
    const month = Number(match[2])
    const year = Number(match[3])
    let hour = match[4] !== undefined ? Number(match[4]) : 0
    const minute = match[5] !== undefined ? Number(match[5]) : 0
    const second = match[6] !== undefined ? Number(match[6]) : 0
    const ampm = match[7] ? String(match[7]).toUpperCase() : null
    if (ampm === 'PM' && hour < 12) hour += 12
    if (ampm === 'AM' && hour === 12) hour = 0
    const date = new Date(year, month - 1, day, hour, minute, second)
    if (
      date.getFullYear() === year
      && date.getMonth() === month - 1
      && date.getDate() === day
    ) {
      return { ok: true, date }
    }
  }
  return { ok: false, date: null }
}

function resolveSource(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: true, value: leadSources.manual }
  }
  const key = normalizePersonKey(raw)
  const mapped = SOURCE_LABEL_MAP[key] || (Object.values(leadSources).includes(key) ? key : null)
  if (!mapped) {
    return { ok: false, value: null, error: 'Invalid lead source' }
  }
  return { ok: true, value: mapped }
}

/**
 * Resolves import phones to E.164.
 * Reuses Meta import dial rules: preserve valid +, apply company timezone/currency
 * dial only for unambiguous local/national numbers. Never invents a country code.
 *
 * @param {unknown} raw
 * @param {{ required?: boolean, companyContext?: { timezone?: string, baseCurrency?: string } }} [options]
 */
function resolvePhone(raw, { required = false, companyContext = {} } = {}) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    if (required) return { ok: false, value: null, error: 'Contact No is required', reason: 'empty' }
    return { ok: true, value: null, reason: '' }
  }
  const text = String(raw).trim()
  const result = normalizeMetaLeadPhone(text, companyContext)
  if (result.ok) {
    return { ok: true, value: result.phone, reason: '' }
  }
  const dial = resolveCompanyDialCode(companyContext)
  let error = 'Phone must be a valid international number'
  if (result.reason === 'empty') {
    error = required ? 'Contact No is required' : ''
    if (!required) return { ok: true, value: null, reason: '' }
  } else if (result.reason === 'ambiguous_country') {
    error = dial
      ? `Contact No "${text}" could not be normalized`
      : `Contact No "${text}" needs a country code (for example +91…). Company timezone/currency does not define a dial code, so the number was not guessed.`
  } else if (result.reason === 'invalid_national') {
    error = dial
      ? `Contact No "${text}" is not a valid local/national number for company dial ${dial}`
      : `Contact No "${text}" is not a valid phone number`
  } else if (result.reason === 'invalid_e164') {
    error = `Contact No "${text}" is not a valid international number`
  } else if (!text.startsWith('+') && !dial) {
    error = `Contact No "${text}" needs a country code starting with + (company dial code unavailable)`
  }
  return { ok: false, value: null, error, reason: result.reason || 'invalid' }
}

/**
 * Loads company catalogs/users once per validate pass.
 */
async function loadCompanyResolutionMaps(companyId) {
  const { CatalogItem, User, Company } = getModels()
  const [statuses, tags, users, company] = await Promise.all([
    CatalogItem.findAll({
      where: { companyId, kind: catalogKinds.status, isActive: true },
      attributes: ['id', 'name', 'key'],
    }),
    CatalogItem.findAll({
      where: { companyId, kind: catalogKinds.tag, isActive: true },
      attributes: ['id', 'name', 'key'],
    }),
    User.findAll({
      where: { companyId, status: userStatuses.active },
      attributes: ['id', 'name', 'email'],
    }),
    Company.findByPk(companyId, {
      attributes: ['id', 'timezone', 'baseCurrency'],
    }),
  ])

  function indexByName(rows) {
    const map = new Map()
    for (const row of rows) {
      const key = normalizePersonKey(row.name)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(row)
    }
    return map
  }

  const companyContext = {
    timezone: company?.timezone || '',
    baseCurrency: company?.baseCurrency || '',
  }

  return {
    statusByName: indexByName(statuses),
    tagByName: indexByName(tags),
    userByName: indexByName(users),
    users,
    companyContext,
    dialCode: resolveCompanyDialCode(companyContext),
  }
}

function resolveNamedEntity(map, raw, label) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: true, value: null }
  }
  const key = normalizePersonKey(raw)
  const matches = map.get(key) || []
  if (matches.length === 0) {
    return { ok: false, value: null, error: `${label} "${String(raw).trim()}" was not found` }
  }
  if (matches.length > 1) {
    return { ok: false, value: null, error: `${label} "${String(raw).trim()}" matches more than one record`, ambiguous: true }
  }
  return { ok: true, value: matches[0] }
}

function resolveTags(tagByName, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: true, ids: [], errors: [] }
  }
  const parts = String(raw).split(/[,;|]/).map((part) => part.trim()).filter(Boolean)
  const ids = []
  const errors = []
  const seen = new Set()
  for (const part of parts) {
    const resolved = resolveNamedEntity(tagByName, part, 'Tag')
    if (!resolved.ok) {
      errors.push(resolved.error)
      continue
    }
    if (resolved.value && !seen.has(resolved.value.id)) {
      seen.add(resolved.value.id)
      ids.push(resolved.value.id)
    }
  }
  return { ok: errors.length === 0, ids, errors }
}

function extractNotes(mapped) {
  const notes = []
  for (let i = 1; i <= IMPORT_NOTES_COUNT; i += 1) {
    const text = mapped[`note${i}`]
    if (text === null || text === undefined || String(text).trim() === '') continue
    const addedOn = parseImportDate(mapped[`note${i}AddedOn`])
    if (mapped[`note${i}AddedOn`] !== '' && mapped[`note${i}AddedOn`] != null && !addedOn.ok) {
      notes.push({
        index: i,
        error: `Notes ${i} Added On is invalid`,
      })
      continue
    }
    notes.push({
      index: i,
      text: String(text).trim().slice(0, 2000),
      addedOn: addedOn.date,
      addedBy: mapped[`note${i}AddedBy`] ? String(mapped[`note${i}AddedBy`]).trim().slice(0, 120) : '',
    })
  }
  return notes
}

function resolveNoteAuthors(notes, userByName, importerUserId) {
  return notes.map((note) => {
    if (note.error) return note
    if (!note.addedBy) {
      return {
        ...note,
        createdBy: importerUserId,
        authorDisplayName: null,
        authorMatched: false,
      }
    }
    const resolved = resolveNamedEntity(userByName, note.addedBy, 'Note author')
    if (resolved.ok && resolved.value) {
      return {
        ...note,
        createdBy: resolved.value.id,
        authorDisplayName: null,
        authorMatched: true,
      }
    }
    // Unambiguous miss or ambiguous → importing user + display name preserved.
    return {
      ...note,
      createdBy: importerUserId,
      authorDisplayName: note.addedBy,
      authorMatched: false,
      authorWarning: resolved.ambiguous
        ? `Notes ${note.index} author is ambiguous; preserved as display name`
        : `Notes ${note.index} author was not matched; preserved as display name`,
    }
  })
}

/**
 * CRM phone matches for Excel duplicate review.
 * Includes soft-deleted leads (paranoid: false) so imports cannot silently
 * recreate a deleted phone as a brand-new lead without an explicit decision.
 *
 * @param {string} companyId
 * @param {string[]} phones
 */
async function findLeadsByPhones(companyId, phones) {
  const unique = [...new Set(phones.filter(Boolean))]
  if (unique.length === 0) return []
  const { Lead } = getModels()
  return Lead.findAll({
    where: {
      companyId,
      phone: { [Op.in]: unique },
    },
    attributes: [
      'id',
      'number',
      'name',
      'phone',
      'email',
      'statusId',
      'primaryAgentId',
      'alternatePhone',
      'deletedAt',
      'deletedBy',
    ],
    paranoid: false,
  })
}

module.exports = {
  normalizePersonKey,
  parseImportDate,
  resolveSource,
  resolvePhone,
  loadCompanyResolutionMaps,
  resolveNamedEntity,
  resolveTags,
  extractNotes,
  resolveNoteAuthors,
  findLeadsByPhones,
  isEmail,
}
