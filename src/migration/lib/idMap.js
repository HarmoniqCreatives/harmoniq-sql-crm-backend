'use strict'

const { v5: uuidv5 } = require('uuid')

/**
 * Stable Mongo ObjectId → SQL UUID mapping for company / branch / team / role / user.
 * Uses UUID v5 so the same Mongo id always maps to the same SQL UUID (idempotent re-import).
 * In-memory by default; can hydrate from / serialize to plain JSON (overrides win).
 */

/** Project-fixed namespace — do not change once production imports exist. */
const MIGRATION_ID_NAMESPACE = 'a8e4c2f1-7b3d-4e9a-9c1f-2d6b8e0a5f47'

function deterministicSqlUuid(entityType, mongoId) {
  return uuidv5(`${entityType}:${String(mongoId)}`, MIGRATION_ID_NAMESPACE)
}

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
   * Returns existing UUID or allocates a deterministic one (idempotent across process restarts).
   */
  function ensure(entityType, mongoId, companyMongoId = null) {
    const key = mapKey(entityType, mongoId)
    const existing = store.get(key)
    if (existing) {
      return existing.sqlUuid
    }
    const sqlUuid = deterministicSqlUuid(entityType, mongoId)
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

module.exports = {
  createIdMap,
  deterministicSqlUuid,
  MIGRATION_ID_NAMESPACE,
}
