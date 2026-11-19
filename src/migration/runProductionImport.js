'use strict'

/**
 * Production LIVE import runner (gated).
 *
 * Scope: companies, roles, branches, teams, users only.
 * - Requires destination snapshot (SELECT) and remaps logical matches.
 * - STOPS on any reconciliation conflict (never bypasses).
 * - findOrCreate by primary key only — never overwrites existing rows.
 * - Never prints password hashes / secrets.
 *
 * REQUIRED process env (do not leave in .env):
 *   MIGRATION_ALLOW_LIVE_SQL_IMPORT=1
 *   MIGRATION_IMPORT_APPROVED=1
 *
 * Do NOT run until dry-run PASS is reviewed.
 *
 * Usage (on VPS, after explicit approval):
 *   cd /home/deploy/apps/melo/backend
 *   MIGRATION_ALLOW_LIVE_SQL_IMPORT=1 MIGRATION_IMPORT_APPROVED=1 \
 *   BACKEND_ROOT=/home/deploy/apps/melo/backend \
 *   EXPORT_PATH=/home/deploy/migration-staging/production-11-user-export.json \
 *   REPORT_DIR=/home/deploy/migration-staging/reports \
 *   REQUIRED_DB_NAME=harmoniq_creative_crm_live \
 *   node src/migration/runProductionImport.js
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const EXPECTED_COMPANIES = 1
const EXPECTED_ROLES = 4
const EXPECTED_ACTIVE_USERS = 11
const DEFAULT_REQUIRED_DB_NAME = 'harmoniq_creative_crm_live'

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  throw err
}

function resolvePaths() {
  const backendRoot = path.resolve(process.env.BACKEND_ROOT || process.cwd())
  const exportPath = path.resolve(
    process.env.EXPORT_PATH
      || '/home/deploy/migration-staging/production-11-user-export.json',
  )
  const reportDir = path.resolve(
    process.env.REPORT_DIR || '/home/deploy/migration-staging/reports',
  )
  const envPath = path.resolve(process.env.ENV_PATH || path.join(backendRoot, '.env'))
  const requiredDbName = String(process.env.REQUIRED_DB_NAME || DEFAULT_REQUIRED_DB_NAME).trim()
  return { backendRoot, exportPath, reportDir, envPath, requiredDbName }
}

function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) fail('ENV_FILE_MISSING', `Missing .env: ${envPath}`)
  const parsed = {}
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    parsed[key] = val
  }
  return parsed
}

function applyEnvMap(envMap) {
  for (const [key, value] of Object.entries(envMap)) {
    if (process.env[key] == null) process.env[key] = value
  }
}

async function selectCounts(sequelize) {
  const counts = {}
  for (const table of ['companies', 'branches', 'teams', 'roles', 'users']) {
    const rows = await sequelize.query(
      `SELECT COUNT(*) AS c FROM \`${table}\``,
      { type: sequelize.QueryTypes.SELECT },
    )
    counts[table] = Number(rows[0].c)
  }
  return counts
}

async function loadDestinationSnapshot(sequelize) {
  const companies = await sequelize.query(
    'SELECT id, nameKey, name, status, isActive FROM companies',
    { type: sequelize.QueryTypes.SELECT },
  )
  const branches = await sequelize.query(
    'SELECT id, companyId, nameKey FROM branches',
    { type: sequelize.QueryTypes.SELECT },
  )
  const teams = await sequelize.query(
    'SELECT id, companyId, branchId, nameKey FROM teams',
    { type: sequelize.QueryTypes.SELECT },
  )
  const roles = await sequelize.query(
    'SELECT id, companyId, `key` FROM roles',
    { type: sequelize.QueryTypes.SELECT },
  )
  const users = await sequelize.query(
    'SELECT id, companyId, email, roleId, status, emailVerified FROM users',
    { type: sequelize.QueryTypes.SELECT },
  )
  return { companies, branches, teams, roles, users }
}

async function main() {
  if (process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT !== '1') {
    fail('LIVE_SQL_IMPORT_ENV_BLOCKED', 'Set MIGRATION_ALLOW_LIVE_SQL_IMPORT=1 for this process only')
  }
  if (process.env.MIGRATION_IMPORT_APPROVED !== '1') {
    fail('LIVE_SQL_IMPORT_APPROVAL_REQUIRED', 'Set MIGRATION_IMPORT_APPROVED=1 for this process only')
  }

  const paths = resolvePaths()
  const envMap = parseEnvFile(paths.envPath)
  const dbName = String(envMap.DB_NAME || '').trim()
  if (dbName !== paths.requiredDbName) {
    fail('DB_NAME_MISMATCH', `DB_NAME="${dbName}" required "${paths.requiredDbName}"`)
  }
  applyEnvMap(envMap)

  const migrationRoot = path.join(paths.backendRoot, 'src/migration')
  const { importToSqlLive } = require(path.join(migrationRoot, 'import/importSql.js'))
  const { isBcryptHashFormat } = require(path.join(migrationRoot, 'lib/passwordGate.js'))
  const { getSequelize, assertDatabaseConnection, closeDatabase } = require(
    path.join(paths.backendRoot, 'src/config/database.js'),
  )
  const { getModels } = require(path.join(paths.backendRoot, 'src/models/index.js'))

  if (!fs.existsSync(paths.exportPath)) {
    fail('EXPORT_FILE_MISSING', `Missing export: ${paths.exportPath}`)
  }
  const exportRaw = fs.readFileSync(paths.exportPath)
  const exportSha = crypto.createHash('sha256').update(exportRaw).digest('hex')
  const payload = JSON.parse(exportRaw.toString('utf8'))

  const companies = payload.companies || []
  const roles = payload.roles || []
  const users = payload.users || []
  const active = users.filter((u) => String(u.status || '').toLowerCase() === 'active')
  if (companies.length !== EXPECTED_COMPANIES) {
    fail('SOURCE_COMPANY_COUNT', `Expected ${EXPECTED_COMPANIES} company`)
  }
  if (roles.length !== EXPECTED_ROLES) {
    fail('SOURCE_ROLE_COUNT', `Expected ${EXPECTED_ROLES} roles`)
  }
  if (active.length !== EXPECTED_ACTIVE_USERS || users.length !== EXPECTED_ACTIVE_USERS) {
    fail('SOURCE_USER_COUNT', `Expected ${EXPECTED_ACTIVE_USERS} active users`)
  }
  const hashOk = users.filter((u) => isBcryptHashFormat(u.passwordHash)).length
  if (hashOk !== EXPECTED_ACTIVE_USERS) {
    fail('SOURCE_HASH_COUNT', `Expected ${EXPECTED_ACTIVE_USERS} valid bcrypt hashes`)
  }
  if (!payload.passwordGate || payload.passwordGate.passed !== true) {
    fail('PASSWORD_GATE_NOT_PASSED', 'Export passwordGate.passed must be true')
  }

  await assertDatabaseConnection()
  const sequelize = getSequelize()
  const dbInfo = (await sequelize.query(
    'SELECT DATABASE() AS db, @@hostname AS host, @@port AS port',
    { type: sequelize.QueryTypes.SELECT },
  ))[0]
  if (String(dbInfo.db) !== paths.requiredDbName) {
    await closeDatabase()
    fail('CONNECTED_DB_MISMATCH', `Connected "${dbInfo.db}" required "${paths.requiredDbName}"`)
  }

  const before = await selectCounts(sequelize)
  const destinationSnapshot = await loadDestinationSnapshot(sequelize)
  const models = getModels()

  let result
  try {
    result = await importToSqlLive(payload, {
      allowLiveImport: true,
      models: {
        Company: models.Company,
        Role: models.Role,
        User: models.User,
        Branch: models.Branch,
        Team: models.Team,
      },
      sequelize,
      destinationSnapshot,
    })
  } catch (error) {
    await closeDatabase()
    if (error.code === 'IMPORT_DESTINATION_CONFLICTS') {
      const conflicts = error.reconciliation?.conflicts || []
      process.stderr.write(`IMPORT_STOPPED_CONFLICTS count=${conflicts.length}\n`)
      for (const c of conflicts) {
        process.stderr.write(
          `- [${c.reason}] ${c.entity} id=${c.id}`
            + `${c.email ? ` email=${c.email}` : ''}`
            + `${c.existingId ? ` existingId=${c.existingId}` : ''}\n`,
        )
      }
    }
    throw error
  }

  const after = await selectCounts(sequelize)
  await closeDatabase()

  fs.mkdirSync(paths.reportDir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(paths.reportDir, 0o700) } catch { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(paths.reportDir, `production-import-${stamp}.md`)
  const lines = [
    '# Production Import Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Result: ${result.ok ? 'OK' : 'FAIL'}`,
    '',
    '## Safety',
    '- Overwrite existing rows: no (findOrCreate by id only)',
    '- Conflicts bypassed: no',
    '- Password hashes printed: never',
    '',
    '## Destination',
    `- DATABASE(): ${dbInfo.db}`,
    `- Host: ${dbInfo.host}`,
    '',
    '## Source',
    `- Export: ${paths.exportPath}`,
    `- SHA-256: ${exportSha}`,
    `- Companies/roles/users: ${EXPECTED_COMPANIES}/${EXPECTED_ROLES}/${EXPECTED_ACTIVE_USERS}`,
    '',
    '## Counts',
    `- Before: ${JSON.stringify(before)}`,
    `- After:  ${JSON.stringify(after)}`,
    `- Inserted: ${JSON.stringify(result.inserted)}`,
    `- Existing skipped: ${JSON.stringify(result.existing)}`,
    `- Remaps applied: ${JSON.stringify(result.remaps)}`,
    '',
  ]
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, { mode: 0o600 })
  fs.chmodSync(reportPath, 0o600)

  process.stdout.write('Production import: OK\n')
  process.stdout.write(`Connected DB: ${dbInfo.db}\n`)
  process.stdout.write(`Inserted: ${JSON.stringify(result.inserted)}\n`)
  process.stdout.write(`Existing skipped: ${JSON.stringify(result.existing)}\n`)
  process.stdout.write(`Remaps: ${JSON.stringify(result.remaps)}\n`)
  process.stdout.write(`Counts before: ${JSON.stringify(before)}\n`)
  process.stdout.write(`Counts after:  ${JSON.stringify(after)}\n`)
  process.stdout.write(`Report: ${reportPath}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`IMPORT_FAILED [${error.code || 'ERROR'}] ${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { main }
