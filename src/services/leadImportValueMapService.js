'use strict'

/**
 * Universal Excel import — value mapping helpers (no hardcoding of Excel values).
 * Maps Excel catalog/enum strings onto existing company catalogs or platform source enums.
 * Never creates catalog records.
 */

const { leadSources } = require('../utils/enums')
const { SOURCE_LABEL_MAP, FIELD_LABELS } = require('./leadImportConstants')

const VALUE_MAP_FIELDS = ['status', 'source', 'assignedAgent', 'tags']

function normalizeValueKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * Collect distinct Excel values for a mapped CRM field (+ occurrence counts).
 * Tags: splits on comma / ; / |.
 *
 * @param {object[]} rows session rows with .values
 * @param {Record<string, string|null>} mapping
 * @param {'status'|'source'|'assignedAgent'|'tags'} field
 */
function collectDistinctValues(rows, mapping, field) {
  const header = Object.entries(mapping || {}).find(
    ([, target]) => target === field,
  )?.[0]
  if (!header) return { field, header: null, values: [] }

  const counts = new Map()
  for (const row of rows || []) {
    const raw = row.values?.[header]
    if (raw === null || raw === undefined || String(raw).trim() === '') continue
    if (field === 'tags') {
      const parts = String(raw).split(/[,;|]/).map((part) => part.trim()).filter(Boolean)
      for (const part of parts) {
        counts.set(part, (counts.get(part) || 0) + 1)
      }
    } else {
      const text = String(raw).trim()
      counts.set(text, (counts.get(text) || 0) + 1)
    }
  }

  const values = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))

  return { field, header, label: FIELD_LABELS[field] || field, values }
}

/**
 * Suggest a catalog/enum target only on exact normalized match (never guess equivalence).
 *
 * @param {string} excelValue
 * @param {'status'|'source'|'assignedAgent'|'tags'} field
 * @param {{ statusByName: Map, userByName: Map, tagByName: Map }} maps
 */
function suggestCatalogMatch(excelValue, field, maps) {
  const key = normalizeValueKey(excelValue)
  if (!key) return { matched: false, targetId: null, targetKey: null, targetLabel: null, confidence: 'none' }

  if (field === 'source') {
    const mapped = SOURCE_LABEL_MAP[key] || (Object.values(leadSources).includes(key) ? key : null)
    if (mapped) {
      return {
        matched: true,
        targetId: null,
        targetKey: mapped,
        targetLabel: mapped,
        confidence: 'exact',
      }
    }
    return { matched: false, targetId: null, targetKey: null, targetLabel: null, confidence: 'none' }
  }

  const map = field === 'status'
    ? maps.statusByName
    : field === 'assignedAgent'
      ? maps.userByName
      : maps.tagByName
  const matches = map.get(key) || []
  if (matches.length === 1) {
    return {
      matched: true,
      targetId: matches[0].id,
      targetKey: matches[0].key || null,
      targetLabel: matches[0].name,
      confidence: 'exact',
    }
  }
  return { matched: false, targetId: null, targetKey: null, targetLabel: null, confidence: 'none' }
}

/**
 * Build value-mapping workspace for the UI (distinct values + exact suggestions only).
 *
 * @param {object[]} rows
 * @param {Record<string, string|null>} mapping
 * @param {object} maps from loadCompanyResolutionMaps
 */
function buildValueMappingWorkspace(rows, mapping, maps) {
  const sourceOptions = Object.values(leadSources).map((key) => ({
    id: key,
    key,
    name: key,
  }))

  const catalogOptions = {
    status: [...(maps.statusByName?.values() || [])].flat().map((row) => ({
      id: row.id,
      key: row.key || null,
      name: row.name,
    })),
    assignedAgent: [...(maps.userByName?.values() || [])].flat().map((row) => ({
      id: row.id,
      key: null,
      name: row.name,
    })),
    tags: [...(maps.tagByName?.values() || [])].flat().map((row) => ({
      id: row.id,
      key: row.key || null,
      name: row.name,
    })),
    source: sourceOptions,
  }

  // Deduplicate options (maps hold arrays per name key)
  for (const field of Object.keys(catalogOptions)) {
    const seen = new Set()
    catalogOptions[field] = catalogOptions[field].filter((row) => {
      const id = row.id
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  const groups = []
  for (const field of VALUE_MAP_FIELDS) {
    if (!Object.values(mapping || {}).includes(field)) continue

    const collected = collectDistinctValues(rows, mapping, field)
    const entries = collected.values.map((item) => {
      const suggestion = suggestCatalogMatch(item.value, field, maps)
      return {
        excelValue: item.value,
        count: item.count,
        suggestion: suggestion.matched ? suggestion : null,
        resolved: false,
      }
    })
    groups.push({
      field,
      header: collected.header,
      label: collected.label,
      entries,
      options: catalogOptions[field] || [],
    })
  }

  return {
    groups,
    sourceEnum: Object.values(leadSources),
  }
}

/**
 * Normalize client valueMappings payload.
 * Shape: { status: { "Dropped": "<statusId>" }, source: { "Direct": "manual" }, ... }
 *
 * @param {unknown} raw
 */
function normalizeValueMappings(raw) {
  const out = {
    status: {},
    source: {},
    assignedAgent: {},
    tags: {},
  }
  if (!raw || typeof raw !== 'object') return out
  for (const field of VALUE_MAP_FIELDS) {
    const block = raw[field]
    if (!block || typeof block !== 'object') continue
    for (const [excelValue, target] of Object.entries(block)) {
      const key = String(excelValue)
      if (!key.trim()) continue
      if (target === null || target === undefined || target === '') continue
      out[field][key] = String(target)
    }
  }
  return out
}

/**
 * Apply user value map for a single status/source/agent string.
 * Returns { ok, value, needReview, message } where value is catalog row, source key, or user row.
 */
function applySingleValueMap(field, rawExcel, valueMappings, maps) {
  if (rawExcel === null || rawExcel === undefined || String(rawExcel).trim() === '') {
    // Empty Lead Source defaults to manual (same as resolveSource / manual create).
    if (field === 'source') {
      return { ok: true, empty: true, value: leadSources.manual, needReview: false, message: '' }
    }
    return { ok: true, empty: true, value: null, needReview: false, message: '' }
  }
  const text = String(rawExcel).trim()
  const mappedTarget = valueMappings?.[field]?.[text]

  if (field === 'source') {
    if (mappedTarget) {
      const key = normalizeValueKey(mappedTarget)
      const allowed = SOURCE_LABEL_MAP[key] || (Object.values(leadSources).includes(key) ? key : null)
      if (!allowed) {
        return {
          ok: false,
          empty: false,
          value: null,
          needReview: true,
          message: `Lead Source "${text}" is mapped to an invalid CRM source`,
        }
      }
      return { ok: true, empty: false, value: allowed, needReview: false, message: '' }
    }
    const auto = suggestCatalogMatch(text, 'source', maps)
    if (auto.matched) {
      return { ok: true, empty: false, value: auto.targetKey, needReview: false, message: '' }
    }
    return {
      ok: false,
      empty: false,
      value: null,
      needReview: true,
      message: `Lead Source "${text}" is not a known CRM source — map it to manual, facebook, instagram, or website`,
    }
  }

  if (field === 'status') {
    if (mappedTarget) {
      const all = [...maps.statusByName.values()].flat()
      const found = all.find((row) => row.id === mappedTarget)
      if (!found) {
        return {
          ok: false,
          empty: false,
          value: null,
          needReview: true,
          message: `Status "${text}" is mapped to a Status that is not in this company`,
        }
      }
      return { ok: true, empty: false, value: found, needReview: false, message: '' }
    }
    const auto = suggestCatalogMatch(text, 'status', maps)
    if (auto.matched) {
      const row = (maps.statusByName.get(normalizeValueKey(text)) || [])[0]
      return { ok: true, empty: false, value: row, needReview: false, message: '' }
    }
    return {
      ok: false,
      empty: false,
      value: null,
      needReview: true,
      message: `Status "${text}" was not found in this company — map it to an existing Status`,
    }
  }

  if (field === 'assignedAgent') {
    if (mappedTarget) {
      const all = [...maps.userByName.values()].flat()
      const found = all.find((row) => row.id === mappedTarget)
      if (!found) {
        return {
          ok: false,
          empty: false,
          value: null,
          needReview: true,
          message: `Assigned agent "${text}" is mapped to a user that is not in this company`,
        }
      }
      return { ok: true, empty: false, value: found, needReview: false, message: '' }
    }
    if (!String(text).trim()) {
      return { ok: true, empty: true, value: null, needReview: false, message: '' }
    }
    const auto = suggestCatalogMatch(text, 'assignedAgent', maps)
    if (auto.matched) {
      const row = (maps.userByName.get(normalizeValueKey(text)) || [])[0]
      return { ok: true, empty: false, value: row, needReview: false, message: '' }
    }
    return {
      ok: false,
      empty: false,
      value: null,
      needReview: true,
      message: `Assigned agent "${text}" was not found — map it to an existing user`,
    }
  }

  return { ok: true, empty: false, value: null, needReview: false, message: '' }
}

/**
 * Resolve tags with optional value map per segment.
 */
function applyTagValueMaps(rawTags, valueMappings, maps) {
  if (rawTags === null || rawTags === undefined || String(rawTags).trim() === '') {
    return { ok: true, ids: [], needReviewMessages: [], errorMessages: [] }
  }
  const parts = String(rawTags).split(/[,;|]/).map((part) => part.trim()).filter(Boolean)
  const ids = []
  const seen = new Set()
  const needReviewMessages = []
  const errorMessages = []

  for (const part of parts) {
    const mappedId = valueMappings?.tags?.[part]
    if (mappedId) {
      const all = [...maps.tagByName.values()].flat()
      const found = all.find((row) => row.id === mappedId)
      if (!found) {
        needReviewMessages.push(`Tag "${part}" is mapped to a Tag that is not in this company`)
        continue
      }
      if (!seen.has(found.id)) {
        seen.add(found.id)
        ids.push(found.id)
      }
      continue
    }
    const auto = suggestCatalogMatch(part, 'tags', maps)
    if (auto.matched) {
      const row = (maps.tagByName.get(normalizeValueKey(part)) || [])[0]
      if (row && !seen.has(row.id)) {
        seen.add(row.id)
        ids.push(row.id)
      }
      continue
    }
    needReviewMessages.push(`Tag "${part}" was not found — map it to an existing Tag`)
  }

  return {
    ok: needReviewMessages.length === 0 && errorMessages.length === 0,
    ids,
    needReviewMessages,
    errorMessages,
  }
}

function headerFingerprint(headers) {
  return (headers || [])
    .map((header) => normalizeValueKey(header))
    .filter(Boolean)
    .join('|')
}

module.exports = {
  VALUE_MAP_FIELDS,
  normalizeValueKey,
  collectDistinctValues,
  suggestCatalogMatch,
  buildValueMappingWorkspace,
  normalizeValueMappings,
  applySingleValueMap,
  applyTagValueMaps,
  headerFingerprint,
}
