'use strict'

const { v4: uuidv4 } = require('uuid')

/**
 * Stable Mongo ObjectId → SQL UUID mapping for company / role / user.
 * In-memory by default; can hydrate from / serialize to plain JSON.
 */
function createIdMap(initialEntries = []) {
  /** @type {Map<string, { sqlUuid: string, companyMongoId: string|null, importedAt: string }>} */
  const store = new Map()

  for (const entry of initialEntries) {
    const key = mapKey(entry.entityType, entry.mongoId)
    store.set(key, {
      sqlUuid: entry.sqlUuid,
      companyMongoId: entry.companyMongoId == null ? null : String(entry.companyMongoId),
      importedAt: entry.importedAt || new Date(0).toISOString(),
    })
  }

  function mapKey(entityType, mongoId) {
    return `${entityType}:${String(mongoId)}`
  }

  function get(entityType, mongoId) {
    const row = store.get(mapKey(entityType, mongoId))
    return row ? row.sqlUuid : null
  }

  function getEntry(entityType, mongoId) {
    return store.get(mapKey(entityType, mongoId)) || null
  }

  /**
   * Returns existing UUID or allocates a new one (idempotent).
   */
  function ensure(entityType, mongoId, companyMongoId = null) {
    const key = mapKey(entityType, mongoId)
    const existing = store.get(key)
    if (existing) {
      return existing.sqlUuid
    }
    const sqlUuid = uuidv4()
    store.set(key, {
      sqlUuid,
      companyMongoId: companyMongoId == null ? null : String(companyMongoId),
      importedAt: new Date().toISOString(),
    })
    return sqlUuid
  }

  function has(entityType, mongoId) {
    return store.has(mapKey(entityType, mongoId))
  }

  function assertSameCompany(entityType, mongoId, expectedCompanyMongoId) {
    const entry = getEntry(entityType, mongoId)
    if (!entry) {
      return { ok: false, reason: 'missing_mapping' }
    }
    if (String(entry.companyMongoId) !== String(expectedCompanyMongoId)) {
      return { ok: false, reason: 'cross_company' }
    }
    return { ok: true }
  }

  function toJSON() {
    const rows = []
    for (const [key, value] of store.entries()) {
      const [entityType, mongoId] = key.split(':')
      rows.push({
        entityType,
        mongoId,
        sqlUuid: value.sqlUuid,
        companyMongoId: value.companyMongoId,
        importedAt: value.importedAt,
      })
    }
    return rows
  }

  function size() {
    return store.size
  }

  return {
    get,
    getEntry,
    ensure,
    has,
    assertSameCompany,
    toJSON,
    size,
  }
}

module.exports = { createIdMap }
