'use strict'

// Load backend/.env so DB_NAME / DB_NAME_TEST are visible before Sequelize boots.
try {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })
} catch (_error) {
  // dotenv is a runtime dependency; ignore if unavailable in exotic runners.
}

/**
 * Shared isolated-test-database guard.
 *
 * Production safety:
 * - Never treat the application/live DB as a test target.
 * - DB_NAME_TEST must be set and look like an isolated test DB.
 * - Original application DB is preserved as DB_NAME_APP before remapping.
 * - When the npm test runner remaps DB_NAME → DB_NAME_TEST, that equality is expected
 *   (snapshot preserved as DB_NAME_APP).
 */

/**
 * Split a DB name into alphanumeric segments for classification.
 * @param {string} name
 * @returns {string[]}
 */
function dbNameSegments(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * True when a name looks like a production/live database.
 * Legitimate isolated names such as `harmoniq_creative_crm_test` are not production-like.
 * Names ending in a live/prod/production segment are always rejected (e.g. `crm_test_live`).
 *
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeProductionDbName(name) {
  const n = String(name || '').trim()
  if (!n) return false
  const parts = dbNameSegments(n)
  if (parts.length === 0) return false
  const last = parts[parts.length - 1]
  if (last === 'live' || last === 'prod' || last === 'production') {
    return true
  }
  const hasProdMarker = parts.some((p) => p === 'live' || p === 'prod' || p === 'production')
  const hasTestMarker = parts.includes('test')
  // e.g. harmoniq_creative_crm_live — prod marker, no test marker
  if (hasProdMarker && !hasTestMarker) {
    return true
  }
  return false
}

/**
 * True when a name is acceptable as an isolated test database.
 * Must include a `test` segment and must not look like production/live.
 *
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeIsolatedTestDbName(name) {
  const n = String(name || '').trim()
  if (!n) return false
  if (looksLikeProductionDbName(n)) return false
  return dbNameSegments(n).includes('test')
}

/**
 * Application DB name used for isolation comparisons.
 * Prefers DB_NAME_APP snapshot (set before remap).
 *
 * @param {NodeJS.ProcessEnv} [envSource]
 * @returns {string}
 */
function resolveApplicationDbName(envSource = process.env) {
  const snapshot = String(envSource.DB_NAME_APP || '').trim()
  if (snapshot) return snapshot
  return String(envSource.DB_NAME || '').trim()
}

/**
 * @param {NodeJS.ProcessEnv} [envSource]
 * @returns {{ ok: boolean, reason?: string, testName?: string, appName?: string }}
 */
function evaluateIsolatedTestDb(envSource = process.env) {
  const testName = String(envSource.DB_NAME_TEST || '').trim()
  if (!testName) {
    return { ok: false, reason: 'DB_NAME_TEST is not set' }
  }
  if (!looksLikeIsolatedTestDbName(testName)) {
    if (looksLikeProductionDbName(testName)) {
      return {
        ok: false,
        reason: 'DB_NAME_TEST looks like a production/live database name',
        testName,
      }
    }
    return {
      ok: false,
      reason: 'DB_NAME_TEST must identify an isolated test database (name must contain a "test" segment)',
      testName,
    }
  }

  const appName = resolveApplicationDbName(envSource)
  if (!appName) {
    return {
      ok: false,
      reason: 'Application DB_NAME (or DB_NAME_APP snapshot) must be set to verify isolation',
      testName,
    }
  }
  if (appName === testName) {
    return {
      ok: false,
      reason: 'DB_NAME_TEST must differ from the application DB_NAME',
      testName,
      appName,
    }
  }
  if (looksLikeProductionDbName(appName) === false && looksLikeProductionDbName(testName)) {
    // defensive — already covered by looksLikeIsolatedTestDbName
    return {
      ok: false,
      reason: 'DB_NAME_TEST looks like a production/live database name',
      testName,
      appName,
    }
  }

  // After remap, DB_NAME equals DB_NAME_TEST; refuse if the *current* target is production-like
  // and is not the approved isolated test name.
  const currentDb = String(envSource.DB_NAME || '').trim()
  if (
    currentDb
    && currentDb !== testName
    && looksLikeProductionDbName(currentDb)
  ) {
    return {
      ok: false,
      reason: 'Current DB_NAME looks like a production/live database',
      testName,
      appName,
    }
  }

  return { ok: true, testName, appName }
}

/**
 * @param {NodeJS.ProcessEnv} [envSource]
 * @returns {boolean}
 */
function isolatedTestDbConfigured(envSource = process.env) {
  return evaluateIsolatedTestDb(envSource).ok
}

/**
 * Hard-fail for runners / boot scripts.
 * @param {NodeJS.ProcessEnv} [envSource]
 * @throws {Error}
 */
function assertIsolatedTestDbOrThrow(envSource = process.env) {
  const result = evaluateIsolatedTestDb(envSource)
  if (!result.ok) {
    throw new Error(
      `[test-isolation] ${result.reason}. `
      + 'Set DB_NAME_TEST to an isolated database (e.g. harmoniq_creative_crm_test) '
      + 'that differs from DB_NAME. Never use production/live databases for tests.',
    )
  }
  return result
}

/**
 * Snapshot the original application DB name, then point Sequelize at DB_NAME_TEST.
 * @param {NodeJS.ProcessEnv} [envSource]
 * @returns {string} remapped DB_NAME
 */
function applyIsolatedTestDbEnv(envSource = process.env) {
  const appName = resolveApplicationDbName(envSource)
  if (!envSource.DB_NAME_APP) {
    envSource.DB_NAME_APP = appName
  }
  // Re-evaluate with snapshot set so remap equality is allowed only after snapshot.
  assertIsolatedTestDbOrThrow(envSource)
  envSource.DB_NAME = String(envSource.DB_NAME_TEST).trim()
  envSource.NODE_ENV = 'test'
  return envSource.DB_NAME
}

/**
 * True when unit-test process must not open MySQL.
 * @param {NodeJS.ProcessEnv} [envSource]
 * @returns {boolean}
 */
function isUnitTestDbBlocked(envSource = process.env) {
  return String(envSource.HC_UNIT_TEST_BLOCK_DB || '') === '1'
}

/**
 * Throws if unit-test DB block is active.
 * @param {NodeJS.ProcessEnv} [envSource]
 */
function assertMysqlAccessAllowed(envSource = process.env) {
  if (isUnitTestDbBlocked(envSource)) {
    throw new Error(
      '[test-isolation] MySQL access is blocked during unit tests (HC_UNIT_TEST_BLOCK_DB=1).',
    )
  }
}

module.exports = {
  dbNameSegments,
  looksLikeProductionDbName,
  looksLikeIsolatedTestDbName,
  resolveApplicationDbName,
  evaluateIsolatedTestDb,
  isolatedTestDbConfigured,
  assertIsolatedTestDbOrThrow,
  applyIsolatedTestDbEnv,
  isUnitTestDbBlocked,
  assertMysqlAccessAllowed,
}
