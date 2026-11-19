'use strict'

/**
 * VPS-compatible, strictly READ-ONLY production dry-run.
 *
 * - Uses the already-transferred private export payload (never prints it).
 * - Loads production backend .env without printing secrets.
 * - Confirms DB_NAME === harmoniq_creative_crm_live BEFORE connecting.
 * - SELECT-only destination snapshot + counts (before/after).
 * - Runs prepareImportPlan + reconcileAgainstDestination.
 * - NEVER calls importToSqlLive / findOrCreate / INSERT / UPDATE / DELETE.
 * - NEVER enables live-import environment flags.
 *
 * VPS defaults (override with env):
 *   BACKEND_ROOT=/home/deploy/apps/melo/backend
 *   EXPORT_PATH=/home/deploy/migration-staging/production-11-user-export.json
 *   REPORT_DIR=/home/deploy/migration-staging/reports
 *   REQUIRED_DB_NAME=harmoniq_creative_crm_live
 *
 * Usage (on VPS):
 *   cd /home/deploy/apps/melo/backend
 *   node src/migration/runProductionReadOnlyDryRun.js
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const EXPECTED_COMPANIES = 1
const EXPECTED_ROLES = 4
const EXPECTED_ACTIVE_USERS = 11
const DEFAULT_REQUIRED_DB_NAME = 'harmoniq_creative_crm_live'

function fail(code, message, extra) {
  const err = new Error(message)
  err.code = code
  if (extra) err.extra = extra
  throw err
}

function resolvePaths() {
  const backendRoot = path.resolve(
    process.env.BACKEND_ROOT || process.cwd(),
  )
  const exportPath = path.resolve(
    process.env.EXPORT_PATH
      || path.join('/home/deploy/migration-staging/production-11-user-export.json'),
  )
  const reportDir = path.resolve(
    process.env.REPORT_DIR
      || path.join('/home/deploy/migration-staging/reports'),
  )
  const envPath = path.resolve(
    process.env.ENV_PATH || path.join(backendRoot, '.env'),
  )
  const requiredDbName = String(
    process.env.REQUIRED_DB_NAME || DEFAULT_REQUIRED_DB_NAME,
  ).trim()
  return { backendRoot, exportPath, reportDir, envPath, requiredDbName }
}

/**
 * Parse KEY=VALUE from .env without printing values.
 * Does not use dotenv console output.
 */
function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    fail('ENV_FILE_MISSING', `Production .env not found: ${envPath}`)
  }
  const raw = fs.readFileSync(envPath, 'utf8')
  const parsed = {}
  for (const line of raw.split('\n')) {
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

function assertNoLiveImportFlags(envMap) {
  const banned = ['MIGRATION_ALLOW_LIVE_SQL_IMPORT', 'MIGRATION_IMPORT_APPROVED']
  for (const key of banned) {
    const fromFile = envMap[key]
    const fromProc = process.env[key]
    if (fromFile === '1' || fromFile === 'true' || fromProc === '1' || fromProc === 'true') {
      fail(
        'LIVE_IMPORT_FLAGS_PRESENT',
        `${key} must not be enabled for read-only dry-run`,
      )
    }
  }
}

function applyEnvMap(envMap) {
  for (const [key, value] of Object.entries(envMap)) {
    if (process.env[key] == null) process.env[key] = value
  }
}

function assertProductionDbName(envMap, requiredDbName) {
  const dbName = String(envMap.DB_NAME || '').trim()
  const dbEnv = String(envMap.DB_ENV || '').trim()
  const nodeEnv = String(envMap.NODE_ENV || '').trim()
  if (!dbName) {
    fail('DB_NAME_MISSING', 'DB_NAME is missing from production .env')
  }
  if (dbName !== requiredDbName) {
    fail(
      'DB_NAME_MISMATCH',
      `Refusing to connect: DB_NAME="${dbName}" (required "${requiredDbName}")`,
    )
  }
  // Soft warnings collected by caller — hard-fail only on DB_NAME.
  return { dbName, dbEnv, nodeEnv }
}

function loadExportPayload(exportPath) {
  if (!fs.existsSync(exportPath)) {
    fail('EXPORT_FILE_MISSING', `Export payload not found: ${exportPath}`)
  }
  const stat = fs.statSync(exportPath)
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(exportPath, 'utf8'))
  } catch (error) {
    fail('EXPORT_FILE_INVALID', `Cannot parse export JSON: ${error.message}`)
  }
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(exportPath))
    .digest('hex')
  return { payload, sha256, bytes: stat.size }
}

function validateSource(payload, { isBcryptHashFormat }) {
  const companies = payload.companies || []
  const roles = payload.roles || []
  const users = payload.users || []
  const activeUsers = users.filter((u) => String(u.status || '').toLowerCase() === 'active')
  const errors = []

  if (companies.length !== EXPECTED_COMPANIES) {
    errors.push(`companies=${companies.length} (expected ${EXPECTED_COMPANIES})`)
  }
  if (roles.length !== EXPECTED_ROLES) {
    errors.push(`roles=${roles.length} (expected ${EXPECTED_ROLES})`)
  }
  if (users.length !== EXPECTED_ACTIVE_USERS || activeUsers.length !== EXPECTED_ACTIVE_USERS) {
    errors.push(
      `users=${users.length} active=${activeUsers.length} (expected ${EXPECTED_ACTIVE_USERS})`,
    )
  }

  const gate = payload.passwordGate || {}
  const gatePassed = gate.passed === true
  if (!gatePassed) {
    errors.push('passwordGate.passed is not true')
  }

  let hashValidCount = 0
  for (const user of users) {
    if (isBcryptHashFormat(user.passwordHash)) hashValidCount += 1
  }
  if (hashValidCount !== EXPECTED_ACTIVE_USERS) {
    errors.push(`validBcryptHashes=${hashValidCount} (expected ${EXPECTED_ACTIVE_USERS})`)
  }

  if (errors.length) {
    fail('SOURCE_VALIDATION_FAILED', errors.join('; '))
  }

  return {
    companies: companies.length,
    roles: roles.length,
    users: users.length,
    activeUsers: activeUsers.length,
    hashValidCount,
    passwordGatePassed: gatePassed,
    passwordGateTestedAt: gate.testedAt || null,
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

async function selectStamp(sequelize) {
  const rows = await sequelize.query(
    `
    SELECT
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM companies) AS companies_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM branches) AS branches_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM teams) AS teams_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM roles) AS roles_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM users) AS users_max_updated
    `,
    { type: sequelize.QueryTypes.SELECT },
  )
  return rows[0]
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

function assessLoginReadiness(records) {
  const issues = []
  for (const company of records.companies || []) {
    if (company.status !== 'ACTIVE') {
      issues.push({
        entity: 'company',
        id: company.id,
        name: company.name,
        issue: `status=${company.status} (login requires ACTIVE)`,
      })
    }
    if (company.isActive !== true) {
      issues.push({
        entity: 'company',
        id: company.id,
        name: company.name,
        issue: 'isActive!=true',
      })
    }
  }

  const roleIds = new Set((records.roles || []).map((r) => r.id))
  const companyIds = new Set((records.companies || []).map((c) => c.id))

  for (const user of records.users || []) {
    if (!companyIds.has(user.companyId)) {
      issues.push({ entity: 'user', email: user.email, issue: 'companyId_unresolved' })
    }
    if (!roleIds.has(user.roleId)) {
      issues.push({ entity: 'user', email: user.email, issue: 'roleId_unresolved' })
    }
    if (user.status !== 'ACTIVE') {
      issues.push({ entity: 'user', email: user.email, issue: `status=${user.status}` })
    }
    if (user.emailVerified !== true) {
      issues.push({ entity: 'user', email: user.email, issue: 'emailVerified!=true' })
    }
    if (!user.passwordHash) {
      issues.push({ entity: 'user', email: user.email, issue: 'passwordHash_missing' })
    }
  }
  return issues
}

function summarizeReconciliation(reconciliation) {
  const details = reconciliation.details || {}
  const existing = []
  const conflicts = []
  for (const entity of ['companies', 'roles', 'branches', 'teams', 'users']) {
    for (const row of details[entity]?.existing || []) existing.push(row)
    for (const row of details[entity]?.conflicts || []) conflicts.push(row)
  }
  // Also top-level conflicts array (authoritative)
  for (const row of reconciliation.conflicts || []) {
    if (!conflicts.some((c) => c.entity === row.entity && c.id === row.id && c.reason === row.reason)) {
      conflicts.push(row)
    }
  }
  return { existing, conflicts }
}

function buildReport(ctx) {
  const { reconciliation } = ctx.plan
  const { existing, conflicts } = summarizeReconciliation(reconciliation || { details: {}, conflicts: [] })
  const unchanged =
    JSON.stringify(ctx.before.counts) === JSON.stringify(ctx.after.counts)
    && JSON.stringify(ctx.before.stamp) === JSON.stringify(ctx.after.stamp)

  const sourceOk = Boolean(ctx.sourceValidation)
  const dbOk = ctx.dbInfo?.db === ctx.requiredDbName
  const noWrites = unchanged
  const noImportFlags = true
  const failReasons = []
  if (!sourceOk) failReasons.push('source_validation')
  if (!ctx.plan.ok) failReasons.push('import_plan_validation')
  if (!dbOk) failReasons.push('db_name_mismatch')
  if (!noWrites) failReasons.push('destination_changed')
  if ((conflicts || []).length > 0) failReasons.push('destination_conflicts')
  if ((ctx.loginIssues || []).length > 0) failReasons.push('login_readiness_issues')

  // PASS means dry-run completed safely and source is valid.
  // Conflicts/login issues are reported as FAIL for cutover readiness.
  const result = failReasons.length === 0 ? 'PASS' : 'FAIL'

  const lines = []
  lines.push('# Production Read-Only Dry-Run Report')
  lines.push('')
  lines.push(`Generated: ${ctx.finishedAt}`)
  lines.push(`Result: **${result}**`)
  if (failReasons.length) {
    lines.push(`Fail reasons: ${failReasons.join(', ')}`)
  }
  lines.push('')
  lines.push('## Safety')
  lines.push(`- importToSqlLive called: **no**`)
  lines.push(`- Live import flags enabled: **no**`)
  lines.push(`- Write statements used: **no** (SELECT only)`)
  lines.push(`- Destination unchanged: **${noWrites ? 'yes' : 'NO'}**`)
  lines.push(`- Backup path (pre-existing): \`/home/deploy/backups/harmoniq_creative_crm_live-2026-11-19T03-05-03-439Z.sql\``)
  lines.push('')
  lines.push('## Destination connection')
  lines.push(`- Required DB_NAME: \`${ctx.requiredDbName}\``)
  lines.push(`- Connected DATABASE(): \`${ctx.dbInfo?.db || 'n/a'}\``)
  lines.push(`- Host (MySQL @@hostname): \`${ctx.dbInfo?.host || 'n/a'}\``)
  lines.push(`- Port: \`${ctx.dbInfo?.port || 'n/a'}\``)
  lines.push(`- DB_ENV / NODE_ENV (from .env, values only): \`${ctx.dbMeta.dbEnv}\` / \`${ctx.dbMeta.nodeEnv}\``)
  lines.push('')
  lines.push('## Source export')
  lines.push(`- Path: \`${ctx.exportPath}\``)
  lines.push(`- Bytes: ${ctx.exportBytes}`)
  lines.push(`- SHA-256: \`${ctx.exportSha256}\``)
  lines.push(`- Companies: ${ctx.sourceValidation.companies}`)
  lines.push(`- Roles: ${ctx.sourceValidation.roles}`)
  lines.push(`- Active users: ${ctx.sourceValidation.activeUsers}`)
  lines.push(`- Valid bcrypt hashes: ${ctx.sourceValidation.hashValidCount}/${EXPECTED_ACTIVE_USERS}`)
  lines.push(`- Password gate: ${ctx.sourceValidation.passwordGatePassed ? 'PASSED' : 'FAILED'} (testedAt=${ctx.sourceValidation.passwordGateTestedAt || 'n/a'})`)
  lines.push('')
  lines.push('## Destination counts')
  lines.push(`- Before: ${JSON.stringify(ctx.before.counts)}`)
  lines.push(`- After:  ${JSON.stringify(ctx.after.counts)}`)
  lines.push(`- max(updatedAt) before: ${JSON.stringify(ctx.before.stamp)}`)
  lines.push(`- max(updatedAt) after:  ${JSON.stringify(ctx.after.stamp)}`)
  lines.push('')
  lines.push('## Reconciliation summary')
  lines.push('')
  lines.push('| Entity | Source | Destination | Ready | Existing (skip) | Conflicts |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  const r = reconciliation || {}
  const singular = {
    companies: 'company',
    branches: 'branch',
    teams: 'team',
    roles: 'role',
    users: 'user',
  }
  for (const entity of ['companies', 'branches', 'teams', 'roles', 'users']) {
    const conflictCount = (r.conflicts || []).filter((c) => c.entity === singular[entity]).length
    lines.push(
      `| ${entity} | ${r.sourceCounts?.[entity] ?? 0} | ${r.destinationCounts?.[entity] ?? 0} | ${r.readyToImport?.[entity] ?? 0} | ${r.existingMatches?.[entity] ?? 0} | ${conflictCount} |`,
    )
  }
  lines.push('')
  lines.push('### Existing matches (skip — do not insert/overwrite)')
  if (!existing.length) lines.push('- None')
  else {
    for (const row of existing) {
      lines.push(
        `- [${row.reason}] ${row.entity} plannedId=${row.id}`
          + `${row.key ? ` key=${row.key}` : ''}`
          + `${row.email ? ` email=${row.email}` : ''}`
          + `${row.existingId ? ` existingId=${row.existingId}` : ''}`
          + `${row.existingNameKey ? ` existingNameKey=${row.existingNameKey}` : ''}`,
      )
    }
  }
  lines.push('')
  lines.push('### Conflicts')
  if (!conflicts.length) lines.push('- None')
  else {
    for (const row of conflicts) {
      lines.push(
        `- [${row.reason}] ${row.entity} id=${row.id}`
          + `${row.email ? ` email=${row.email}` : ''}`
          + `${row.existingId ? ` existingId=${row.existingId}` : ''}`
          + `${row.existingCompanyId ? ` existingCompanyId=${row.existingCompanyId}` : ''}`
          + `${row.existingNameKey ? ` existingNameKey=${row.existingNameKey}` : ''}`,
      )
    }
  }
  lines.push('')
  lines.push('### Ready to import (new ids)')
  for (const entity of ['companies', 'roles', 'branches', 'teams', 'users']) {
    const ready = r.details?.[entity]?.ready || []
    lines.push(`- ${entity}: ${ready.length}`)
  }
  lines.push('')
  lines.push('## Destination ID remaps (logical matches → existing production ids)')
  lines.push(`- companies: ${ctx.plan.remaps?.companies ?? 0}`)
  lines.push(`- roles: ${ctx.plan.remaps?.roles ?? 0}`)
  lines.push(`- branches: ${ctx.plan.remaps?.branches ?? 0}`)
  lines.push(`- teams: ${ctx.plan.remaps?.teams ?? 0}`)
  lines.push(`- users: ${ctx.plan.remaps?.users ?? 0}`)
  lines.push('- Remapped rows are skipped via findOrCreate (no overwrite). New users keep remapped companyId/roleId FKs.')
  lines.push('')
  lines.push('## Login readiness (planned records after remap)')
  if (!(ctx.loginIssues || []).length) {
    lines.push('- All planned companies/users satisfy ACTIVE + emailVerified + FK presence checks')
  } else {
    for (const issue of ctx.loginIssues) {
      lines.push(
        `- ${issue.entity}${issue.email ? ` ${issue.email}` : ''}${issue.name ? ` ${issue.name}` : ''}: ${issue.issue}`,
      )
    }
  }
  lines.push('')
  lines.push('## Validation warnings (redacted codes only)')
  const warnings = ctx.plan.validation?.warnings || []
  if (!warnings.length) lines.push('- None')
  else {
    const byCode = {}
    for (const w of warnings) byCode[w.code] = (byCode[w.code] || 0) + 1
    for (const [code, n] of Object.entries(byCode)) {
      lines.push(`- ${code}: ${n}`)
    }
  }
  lines.push('')
  lines.push('## Validation errors')
  const errors = ctx.plan.validation?.errors || []
  if (!errors.length) lines.push('- None')
  else {
    for (const e of errors) {
      lines.push(`- [${e.code}] ${e.message}`)
    }
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('- Password hashes, tokens, and DB credentials are not included in this report.')
  lines.push('- This dry-run does not modify production data.')
  lines.push('- Do not run live import until this report is reviewed and separately approved.')
  lines.push('')
  return { result, failReasons, markdown: lines.join('\n'), existing, conflicts }
}

async function main() {
  const startedAt = new Date().toISOString()
  const paths = resolvePaths()

  // Clear any accidental live-import flags in this process.
  delete process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT
  delete process.env.MIGRATION_IMPORT_APPROVED

  const envMap = parseEnvFile(paths.envPath)
  assertNoLiveImportFlags(envMap)
  const dbMeta = assertProductionDbName(envMap, paths.requiredDbName)
  applyEnvMap(envMap)

  // Load migration helpers from BACKEND_ROOT so VPS deploy path works.
  const migrationRoot = path.join(paths.backendRoot, 'src/migration')
  const { prepareImportPlan } = require(path.join(migrationRoot, 'import/importSql.js'))
  const { isBcryptHashFormat } = require(path.join(migrationRoot, 'lib/passwordGate.js'))
  const { redactSecrets } = require(path.join(migrationRoot, 'lib/sanitize.js'))

  // Guard: ensure importToSqlLive is never invoked from this runner.
  const importSql = require(path.join(migrationRoot, 'import/importSql.js'))
  if (typeof importSql.importToSqlLive === 'function') {
    importSql.importToSqlLive = async function blockedImport() {
      fail('IMPORT_BLOCKED_IN_DRY_RUN', 'importToSqlLive is disabled in read-only dry-run runner')
    }
  }

  const { payload, sha256, bytes } = loadExportPayload(paths.exportPath)
  const sourceValidation = validateSource(payload, { isBcryptHashFormat })

  // Connect using production backend database module (after DB_NAME gate).
  const { getSequelize, assertDatabaseConnection, closeDatabase } = require(
    path.join(paths.backendRoot, 'src/config/database.js'),
  )

  await assertDatabaseConnection()
  const sequelize = getSequelize()

  const dbInfoRows = await sequelize.query(
    'SELECT DATABASE() AS db, @@hostname AS host, @@port AS port, @@read_only AS read_only',
    { type: sequelize.QueryTypes.SELECT },
  )
  const dbInfo = dbInfoRows[0]
  if (String(dbInfo.db) !== paths.requiredDbName) {
    await closeDatabase()
    fail(
      'CONNECTED_DB_MISMATCH',
      `Connected DATABASE()="${dbInfo.db}" but required "${paths.requiredDbName}"`,
    )
  }

  const before = {
    counts: await selectCounts(sequelize),
    stamp: await selectStamp(sequelize),
  }
  const destinationSnapshot = await loadDestinationSnapshot(sequelize)

  const plan = prepareImportPlan(payload, { destinationSnapshot })
  const loginIssues = plan.records ? assessLoginReadiness(plan.records) : [{ issue: 'no_records' }]

  const after = {
    counts: await selectCounts(sequelize),
    stamp: await selectStamp(sequelize),
  }

  await closeDatabase()

  const finishedAt = new Date().toISOString()
  const reportCtx = {
    startedAt,
    finishedAt,
    requiredDbName: paths.requiredDbName,
    exportPath: paths.exportPath,
    exportSha256: sha256,
    exportBytes: bytes,
    sourceValidation,
    dbMeta,
    dbInfo,
    before,
    after,
    plan,
    loginIssues,
  }
  const report = buildReport(reportCtx)

  fs.mkdirSync(paths.reportDir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(paths.reportDir, 0o700) } catch { /* ignore */ }

  const stamp = finishedAt.replace(/[:.]/g, '-')
  const reportPath = path.join(paths.reportDir, `production-readonly-dry-run-${stamp}.md`)
  const jsonPath = path.join(paths.reportDir, `production-readonly-dry-run-${stamp}.json`)

  fs.writeFileSync(reportPath, `${report.markdown}\n`, { mode: 0o600 })
  fs.chmodSync(reportPath, 0o600)

  const jsonSafe = redactSecrets({
    result: report.result,
    failReasons: report.failReasons,
    startedAt,
    finishedAt,
    requiredDbName: paths.requiredDbName,
    connectedDb: dbInfo.db,
    exportPath: paths.exportPath,
    exportSha256: sha256,
    sourceValidation,
    before,
    after,
    reconciliation: plan.reconciliation,
    existing: report.existing,
    conflicts: report.conflicts,
    loginIssues,
    validationErrorCodes: (plan.validation?.errors || []).map((e) => e.code),
    validationWarningCodes: (plan.validation?.warnings || []).map((w) => w.code),
  })
  fs.writeFileSync(jsonPath, `${JSON.stringify(jsonSafe, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(jsonPath, 0o600)

  process.stdout.write(report.markdown)
  process.stdout.write('\n')
  process.stdout.write(`Report written: ${reportPath}\n`)
  process.stdout.write(`JSON summary: ${jsonPath}\n`)
  process.exitCode = report.result === 'PASS' ? 0 : 1
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`DRY_RUN_FAILED [${error.code || 'ERROR'}] ${error.message}\n`)
    process.exitCode = 2
  })
}

module.exports = { main }
