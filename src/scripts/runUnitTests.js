'use strict'

/**
 * DB-free unit tests only — never opens MySQL.
 *
 * Hard blocks (applied before any test file loads):
 * - HC_UNIT_TEST_BLOCK_DB=1 (enforced in src/config/database.js)
 * - --require test/helpers/blockDbConnections.js
 *   patches mysql2 / mysql2/promise and Sequelize MySQL connect/authenticate/query
 *
 * Safe to run without DB_NAME_TEST. Does not migrate, seed, or connect.
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const UNIT_GLOBS = [
  'test/notificationPushFcm.test.js',
  'test/notificationPhaseJ.test.js',
  'test/leadImportUnit.test.js',
  'test/metaPhone.test.js',
  'test/dbEnv.test.js',
  'test/accessPermissions.test.js',
  'test/rolePermissionsUpdate.unit.test.js',
  'test/requirePermission.middleware.test.js',
  'test/passwordCompatibility.test.js',
  'test/mailFrom.test.js',
  'test/leadOriginProvenance.test.js',
  'test/isolatedTestDb.unit.test.js',
  'test/notificationPushReliability.unit.test.js',
  'test/notificationPushReliability.lifecycle.unit.test.js',
  'test/p2TenantSecurity.test.js',
  'test/metaP1Security.test.js',
]

function main() {
  const backendRoot = path.resolve(__dirname, '../..')
  const blockPreload = path.join(backendRoot, 'test/helpers/blockDbConnections.js')

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    MAIL_DRIVER: process.env.MAIL_DRIVER || 'memory',
    HC_UNIT_TEST_BLOCK_DB: '1',
  }

  console.log(
    '[test-isolation] Running DB-free unit tests '
    + '(HC_UNIT_TEST_BLOCK_DB=1; MySQL drivers blocked).',
  )

  const result = spawnSync(
    process.execPath,
    ['--require', blockPreload, '--test', '--test-concurrency=1', ...UNIT_GLOBS],
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
