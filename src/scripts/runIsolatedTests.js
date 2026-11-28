'use strict'

/**
 * Production-safe integration test runner.
 *
 * Requires explicit DB_NAME_TEST, proves it differs from the application DB_NAME,
 * snapshots the original name as DB_NAME_APP, remaps DB_NAME → DB_NAME_TEST,
 * then runs node:test.
 *
 * Never falls back to the application database. Never targets production/live names.
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })
} catch (_error) {
  // optional
}

const {
  assertIsolatedTestDbOrThrow,
  applyIsolatedTestDbEnv,
  looksLikeProductionDbName,
  looksLikeIsolatedTestDbName,
} = require('../../test/helpers/isolatedTestDb')

function main() {
  // Keep any inherited unit-test block active through validation so this parent
  // process cannot open MySQL while checking env. Cleared only after remap succeeds.
  const inheritedUnitBlock = String(process.env.HC_UNIT_TEST_BLOCK_DB || '')

  const appName = String(process.env.DB_NAME || '').trim()
  const testName = String(process.env.DB_NAME_TEST || '').trim()

  if (!testName) {
    console.error(
      '[test-isolation] Refusing to run tests: DB_NAME_TEST is required.\n'
      + '  Example: DB_NAME_TEST=harmoniq_creative_crm_test npm test\n'
      + '  Never run tests against production or the shared application database.',
    )
    process.exit(1)
  }

  if (!appName) {
    console.error(
      '[test-isolation] Refusing to run tests: DB_NAME must be set so isolation can be verified against DB_NAME_TEST.',
    )
    process.exit(1)
  }

  if (testName === appName) {
    console.error(
      '[test-isolation] Refusing to run tests: DB_NAME_TEST must differ from DB_NAME.\n'
      + `  DB_NAME=${appName}\n`
      + `  DB_NAME_TEST=${testName}`,
    )
    process.exit(1)
  }

  if (looksLikeProductionDbName(testName) || !looksLikeIsolatedTestDbName(testName)) {
    console.error(
      '[test-isolation] Refusing to run tests: DB_NAME_TEST is not a safe isolated test database name.\n'
      + `  DB_NAME_TEST=${testName}\n`
      + '  Use a name with a "test" segment that does not look like production/live '
      + '(e.g. harmoniq_creative_crm_test).',
    )
    process.exit(1)
  }

  if (looksLikeProductionDbName(appName)) {
    console.error(
      '[test-isolation] Refusing to run tests while application DB_NAME looks like production/live.\n'
      + `  DB_NAME=${appName}\n`
      + '  Point DB_NAME at a non-production application database, and DB_NAME_TEST at an isolated test DB.',
    )
    process.exit(1)
  }

  // Preserve the original application DB name separately before remapping.
  process.env.DB_NAME_APP = appName
  try {
    assertIsolatedTestDbOrThrow(process.env)
    applyIsolatedTestDbEnv(process.env)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  if (process.env.DB_NAME_APP !== appName) {
    console.error(
      '[test-isolation] Internal error: DB_NAME_APP snapshot was altered unexpectedly.',
    )
    process.exit(1)
  }
  if (process.env.DB_NAME !== testName) {
    console.error(
      '[test-isolation] Internal error: DB_NAME was not remapped to DB_NAME_TEST.',
    )
    process.exit(1)
  }

  console.log(
    `[test-isolation] Using isolated DB_NAME=${process.env.DB_NAME} `
    + `(app snapshot DB_NAME_APP=${process.env.DB_NAME_APP})`,
  )

  const backendRoot = path.resolve(__dirname, '../..')
  const extraArgs = process.argv.slice(2)
  const testArgs = extraArgs.length > 0
    ? extraArgs
    : ['test/*.test.js']

  // Remove unit-test MySQL block ONLY after DB_NAME_TEST checks + remap succeeded.
  const env = { ...process.env }
  delete env.HC_UNIT_TEST_BLOCK_DB
  if (inheritedUnitBlock === '1') {
    console.log(
      '[test-isolation] Cleared HC_UNIT_TEST_BLOCK_DB for integration child after isolation checks passed.',
    )
  }

  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...testArgs],
    {
      cwd: backendRoot,
      env,
      stdio: 'inherit',
      shell: false,
    },
  )

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  process.exit(result.status == null ? 1 : result.status)
}

main()
