'use strict'

/**
 * REAL SOURCE DATA DRY-RUN (read-only)
 *
 * - Live Mongo export from faloniq-crm (MIGRATION_ALLOW_LIVE_MONGO=1 only)
 * - Password gate from PASSWORD_GATE_STATUS.json
 * - Destination snapshot from Harmoniq SQL (SELECT only)
 * - Validates + reconciles; writes report
 *
 * NEVER enables live SQL import flags. NEVER calls importToSqlLive.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const mongoose = require('/home/avinash/Documents/Project/faloniq-crm/backend/node_modules/mongoose')

const FALONIQ_BACKEND = '/home/avinash/Documents/Project/faloniq-crm/backend'
const HARMONIQ_BACKEND = '/home/avinash/Documents/Project/Harmoniq-creative-crm/backend'
const REPORT_PATH = path.join(
  HARMONIQ_BACKEND,
  'src/migration/reports/real-source-production-dry-run-report.md',
)
const EXPORT_PATH = path.join(
  HARMONIQ_BACKEND,
  'src/migration/reports/real-source-export.redacted.json',
)

function loadDotenv(envPath) {
  // Minimal dotenv without printing values
  const raw = fs.readFileSync(envPath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] == null) process.env[key] = val
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function assertNoLiveImportFlags() {
  const banned = [
    'MIGRATION_ALLOW_LIVE_SQL_IMPORT',
    'MIGRATION_IMPORT_APPROVED',
  ]
  for (const key of banned) {
    if (process.env[key] === '1' || process.env[key] === 'true') {
      throw new Error(`Refusing to run: ${key} is set. Unset it for dry-run only.`)
    }
  }
}

async function exportLiveMongo() {
  loadDotenv(path.join(FALONIQ_BACKEND, '.env'))
  process.env.MIGRATION_ALLOW_LIVE_MONGO = '1'

  const { exportFromMongoLive } = require(path.join(
    HARMONIQ_BACKEND,
    'src/migration/export/exportMongo.js',
  ))

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  })

  // Register faloniq models against this connection
  const Company = require(path.join(FALONIQ_BACKEND, 'src/models/Company.js'))
  const Branch = require(path.join(FALONIQ_BACKEND, 'src/models/Branch.js'))
  const Team = require(path.join(FALONIQ_BACKEND, 'src/models/Team.js'))
  const Role = require(path.join(FALONIQ_BACKEND, 'src/models/Role.js'))
  const User = require(path.join(FALONIQ_BACKEND, 'src/models/User.js'))

  const gatePath = path.join(
    HARMONIQ_BACKEND,
    'src/migration/PASSWORD_GATE_STATUS.json',
  )
  const passwordGate = JSON.parse(fs.readFileSync(gatePath, 'utf8'))

  const exportPayload = await exportFromMongoLive({
    allowLiveExport: true,
    collections: { Company, Branch, Team, Role, User },
    passwordGate: {
      passed: passwordGate.status === 'PASSED' || passwordGate.passed === true,
      testedAt: passwordGate.testedAt || null,
      note: passwordGate.note || null,
    },
    companyActiveHints: {},
  })

  await mongoose.disconnect()
  delete process.env.MIGRATION_ALLOW_LIVE_MONGO

  return { exportPayload, passwordGate }
}

async function countSqlTables(sequelize) {
  const counts = {}
  for (const table of ['companies', 'branches', 'teams', 'roles', 'users']) {
    const [[row]] = await sequelize.query(`SELECT COUNT(*) AS c FROM \`${table}\``)
    counts[table] = Number(row.c)
  }
  const [[stamp]] = await sequelize.query(`
    SELECT
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM companies) AS companies_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM branches) AS branches_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM teams) AS teams_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM roles) AS roles_max_updated,
      (SELECT UNIX_TIMESTAMP(MAX(updatedAt)) FROM users) AS users_max_updated
  `)
  return { counts, stamp }
}

async function loadDestinationSnapshot() {
  // Clear faloniq env bleed; load Harmoniq DB env
  delete process.env.MONGODB_URI
  loadDotenv(path.join(HARMONIQ_BACKEND, '.env'))

  // Force module resolution from Harmoniq backend
  const { getSequelize, assertDatabaseConnection, closeDatabase } = require(path.join(
    HARMONIQ_BACKEND,
    'src/config/database.js',
  ))
  const { getModels } = require(path.join(HARMONIQ_BACKEND, 'src/models/index.js'))

  await assertDatabaseConnection()
  const sequelize = getSequelize()
  const before = await countSqlTables(sequelize)

  const { Company, Branch, Team, Role, User } = getModels()
  const [companies, branches, teams, roles, users] = await Promise.all([
    Company.findAll({ attributes: ['id', 'nameKey'], raw: true }),
    Branch.findAll({ attributes: ['id', 'companyId', 'nameKey'], raw: true }),
    Team.findAll({ attributes: ['id', 'companyId', 'branchId', 'nameKey'], raw: true }),
    Role.findAll({ attributes: ['id', 'companyId', 'key'], raw: true }),
    User.findAll({ attributes: ['id', 'companyId', 'email'], raw: true }),
  ])

  const snapshot = { companies, branches, teams, roles, users }
  return { sequelize, closeDatabase, before, snapshot }
}

function fingerprintHashes(users) {
  return users.map((u) => ({
    email: String(u.email || '').toLowerCase(),
    present: Boolean(u.passwordHash),
    bcryptFormat: typeof u.passwordHash === 'string' && /^\$2[aby]\$\d{2}\$/.test(u.passwordHash),
    sha256: u.passwordHash ? sha256(u.passwordHash) : null,
  }))
}

function buildReport({
  command,
  exportPayload,
  passwordGate,
  dry,
  hashCheck,
  before,
  after,
  dbInfo,
  startedAt,
  finishedAt,
}) {
  const v = dry.validation
  const r = dry.reconciliation || {}
  const lines = []
  lines.push('# Real Source Data → Production Destination Dry-Run Report')
  lines.push('')
  lines.push(`Generated: ${finishedAt}`)
  lines.push(`Started: ${startedAt}`)
  lines.push(`Result: ${v.ok ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push('## Exact command')
  lines.push('```bash')
  lines.push(command)
  lines.push('```')
  lines.push('')
  lines.push('## Safety confirmation')
  lines.push(`- Live SQL import flags enabled: **no** (MIGRATION_ALLOW_LIVE_SQL_IMPORT unset / not 1; MIGRATION_IMPORT_APPROVED unset / not 1)`)
  lines.push(`- importToSqlLive invoked: **no**`)
  lines.push(`- Destination DB: \`${dbInfo.db}\` @ ${dbInfo.host}:${dbInfo.port}`)
  lines.push(`- Destination counts before: ${JSON.stringify(before.counts)}`)
  lines.push(`- Destination counts after:  ${JSON.stringify(after.counts)}`)
  lines.push(`- Destination max(updatedAt) before: ${JSON.stringify(before.stamp)}`)
  lines.push(`- Destination max(updatedAt) after:  ${JSON.stringify(after.stamp)}`)
  const unchanged =
    JSON.stringify(before.counts) === JSON.stringify(after.counts) &&
    JSON.stringify(before.stamp) === JSON.stringify(after.stamp)
  lines.push(`- Production records inserted/updated/deleted: **${unchanged ? 'NONE (unchanged)' : 'CHANGED — INVESTIGATE'}**`)
  lines.push('')
  lines.push('## Source export')
  lines.push(`- Source: live Mongo (\`mongo-live\`) via \`exportFromMongoLive\``)
  lines.push(`- Exported at: ${exportPayload.meta.exportedAt}`)
  lines.push(`- Companies: ${exportPayload.counts.companies}`)
  lines.push(`- Branches: ${exportPayload.counts.branches}`)
  lines.push(`- Teams: ${exportPayload.counts.teams}`)
  lines.push(`- Roles: ${exportPayload.counts.roles}`)
  lines.push(`- Users: ${exportPayload.counts.users}`)
  lines.push('')
  lines.push('## Password validation')
  lines.push(`- Gate file status: ${passwordGate.status || (passwordGate.passed ? 'PASSED' : 'PENDING')}`)
  lines.push(`- Gate testedAt: ${passwordGate.testedAt || 'n/a'}`)
  lines.push(`- Export passwordGate.passed: ${exportPayload.passwordGate.passed}`)
  lines.push(`- Validation passwordGate.passed: ${v.passwordGate.passed}`)
  lines.push(`- Users with bcrypt hashes present: ${hashCheck.sourcePresent}/${hashCheck.total}`)
  lines.push(`- Users with valid bcrypt format: ${hashCheck.sourceFormatOk}/${hashCheck.total}`)
  lines.push(`- Transform preserved hash fingerprints (sha256 match): ${hashCheck.preserved}/${hashCheck.total}`)
  lines.push(`- Hashes printed in this report: **never**`)
  lines.push('')
  lines.push('## Validation summary')
  lines.push(`- Errors: ${v.errors.length}`)
  if (v.errors.length === 0) lines.push('- None')
  else for (const e of v.errors) lines.push(`- [${e.code}] ${e.message}`)
  lines.push('')
  lines.push(`- Warnings: ${v.warnings.length}`)
  if (v.warnings.length === 0) lines.push('- None')
  else for (const w of v.warnings) lines.push(`- [${w.code}] ${w.message}`)
  lines.push('')
  lines.push('## Destination reconciliation')
  lines.push('')
  lines.push('| Entity | Source | Destination | Ready | Existing (skip) | Conflicts |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
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
  const existingDetails = []
  for (const entity of ['companies', 'roles', 'branches', 'teams', 'users']) {
    for (const row of r.details?.[entity]?.existing || []) {
      existingDetails.push(row)
    }
  }
  if (!existingDetails.length) {
    lines.push('- None')
  } else {
    for (const c of existingDetails) {
      lines.push(
        `- [${c.reason}] ${c.entity} plannedId=${c.id}${c.email ? ` email=${c.email}` : ''}${c.key ? ` key=${c.key}` : ''}${c.existingId ? ` existingId=${c.existingId}` : ''}${c.existingNameKey ? ` existingNameKey=${c.existingNameKey}` : ''}`,
      )
    }
  }
  lines.push('')
  lines.push('### Conflicts / duplicate keys')
  if (!(r.conflicts || []).length) {
    lines.push('- None')
  } else {
    for (const c of r.conflicts) {
      lines.push(
        `- [${c.reason}] ${c.entity} id=${c.id}${c.email ? ` email=${c.email}` : ''}${c.existingId ? ` existingId=${c.existingId}` : ''}${c.existingCompanyId ? ` existingCompanyId=${c.existingCompanyId}` : ''}`,
      )
    }
  }
  lines.push('')
  lines.push('### Missing dependencies')
  const missing = (v.errors || []).filter((e) =>
    /missing|fk|foreign|unresolved|invalid_.*Id|company_not_found|role_not_found|branch_not_found|team_not_found/i.test(
      e.code || '',
    ),
  )
  if (!missing.length) lines.push('- None (no FK/missing-dependency validation errors)')
  else for (const e of missing) lines.push(`- [${e.code}] ${e.message}`)
  lines.push('')
  lines.push('## Transform preview (redacted)')
  lines.push('```json')
  lines.push(JSON.stringify(dry.transformPreview, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('## Full validation markdown')
  lines.push('')
  lines.push(dry.reportMarkdown)
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const startedAt = new Date().toISOString()
  const command = [
    'cd /home/avinash/Documents/Project/Harmoniq-creative-crm/backend && \\',
    'node src/migration/runRealSourceDryRun.js',
  ].join('\n')

  assertNoLiveImportFlags()

  const { exportPayload, passwordGate } = await exportLiveMongo()

  // Redacted export artifact (no password hashes)
  const redactedExport = {
    ...exportPayload,
    users: (exportPayload.users || []).map((u) => ({
      ...u,
      passwordHash: u.passwordHash ? '[REDACTED]' : null,
    })),
  }
  fs.writeFileSync(EXPORT_PATH, JSON.stringify(redactedExport, null, 2))

  const sourceFingerprints = fingerprintHashes(exportPayload.users || [])

  const { sequelize, closeDatabase, before, snapshot } = await loadDestinationSnapshot()

  const [[dbInfo]] = await sequelize.query(
    'SELECT DATABASE() AS db, @@hostname AS host, @@port AS port',
  )

  const { runDryRun } = require(path.join(HARMONIQ_BACKEND, 'src/migration/dryRun.js'))
  const { transformExportToSqlRecords } = require(path.join(
    HARMONIQ_BACKEND,
    'src/migration/lib/validators.js',
  ))
  const { createIdMap } = require(path.join(HARMONIQ_BACKEND, 'src/migration/lib/idMap.js'))

  const dry = runDryRun(exportPayload, {
    title: 'Real Source Dry-Run (Mongo live → SQL destination)',
    destinationSnapshot: snapshot,
  })

  // Hash preservation check via transform (same as dry-run path)
  const idMap = createIdMap()
  let transformRecords = null
  let transformError = null
  try {
    transformRecords = transformExportToSqlRecords(exportPayload, idMap, {})
  } catch (err) {
    transformError = err.message
  }

  let preserved = 0
  if (transformRecords) {
    const byEmail = new Map(
      transformRecords.users.map((u) => [String(u.email || '').toLowerCase(), u]),
    )
    for (const src of sourceFingerprints) {
      const dest = byEmail.get(src.email)
      if (dest && dest.passwordHash && sha256(dest.passwordHash) === src.sha256) {
        preserved += 1
      }
    }
  }

  const hashCheck = {
    total: sourceFingerprints.length,
    sourcePresent: sourceFingerprints.filter((x) => x.present).length,
    sourceFormatOk: sourceFingerprints.filter((x) => x.bcryptFormat).length,
    preserved,
    transformError,
  }

  const after = await countSqlTables(sequelize)
  await closeDatabase()

  const finishedAt = new Date().toISOString()
  const report = buildReport({
    command,
    exportPayload,
    passwordGate,
    dry,
    hashCheck,
    before,
    after,
    dbInfo,
    startedAt,
    finishedAt,
  })

  fs.writeFileSync(REPORT_PATH, report)
  process.stdout.write(report)
  process.stdout.write('\n')
  process.stdout.write(`\n# Artifacts\n- Report: ${REPORT_PATH}\n- Redacted export: ${EXPORT_PATH}\n`)
  process.exitCode = dry.validation.ok ? 0 : 1
}

main().catch((err) => {
  console.error('DRY_RUN_FAILED', err && err.message ? err.message : err)
  process.exit(2)
})
