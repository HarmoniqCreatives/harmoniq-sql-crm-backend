'use strict'

/**
 * Offline production export from MongoDB Compass JSON backups.
 *
 * - Does NOT connect to MongoDB or SQL.
 * - Does NOT modify source backup files.
 * - Writes the ORIGINAL unredacted payload OUTSIDE the git repository
 *   with owner-only directory/file permissions.
 * - Never prints password hashes, passwords, tokens, or the full payload.
 *
 * Usage:
 *   cd ~/Documents/Project/Harmoniq-creative-crm/backend
 *   node src/migration/runCompassBackupExport.js
 *
 * Optional:
 *   COMPASS_BACKUP_DIR=/path/to/Mongodb \
 *   EXPORT_OUT=~/.local/share/harmoniq-migration/production-11-user-export.json \
 *   node src/migration/runCompassBackupExport.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const { exportFromCompassBackupDir } = require('./export/exportMongo')
const { isBcryptHashFormat } = require('./lib/passwordGate')

const DEFAULT_BACKUP_DIR = '/home/avinash/Downloads/Mongodb'
const DEFAULT_OUT_FILE = path.join(
  os.homedir(),
  '.local/share/harmoniq-migration/production-11-user-export.json',
)
const EXPECTED_COMPANIES = 1
const EXPECTED_ROLES = 4
const EXPECTED_ACTIVE_USERS = 11

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  throw err
}

function loadPasswordGateStatus() {
  const gatePath = path.join(__dirname, 'PASSWORD_GATE_STATUS.json')
  if (!fs.existsSync(gatePath)) {
    fail('PASSWORD_GATE_FILE_MISSING', `Missing password gate file: ${gatePath}`)
  }
  let gate
  try {
    gate = JSON.parse(fs.readFileSync(gatePath, 'utf8'))
  } catch (error) {
    fail('PASSWORD_GATE_FILE_INVALID', `Cannot parse password gate file: ${error.message}`)
  }
  const passed = gate.status === 'PASSED' || gate.passed === true
  if (!passed) {
    fail(
      'PASSWORD_GATE_NOT_PASSED',
      'Password compatibility gate is not PASSED — refusing to write unredacted export',
    )
  }
  return {
    passed: true,
    testedAt: gate.testedAt || null,
    note: gate.note || null,
    status: gate.status || 'PASSED',
  }
}

function assertOutsideRepository(outFile) {
  const repoRoot = path.resolve(__dirname, '../../..')
  const resolvedOut = path.resolve(outFile)
  const rel = path.relative(repoRoot, resolvedOut)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    fail(
      'EXPORT_PATH_INSIDE_REPO',
      `Refusing to write unredacted export inside the repository: ${resolvedOut}`,
    )
  }
}

function ensurePrivateOutputPath(outFile) {
  assertOutsideRepository(outFile)
  const dir = path.dirname(outFile)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Reinforce owner-only even if the directory already existed with looser perms.
  fs.chmodSync(dir, 0o700)
  return outFile
}

function validatePayload(payload, passwordGate) {
  if (!payload || typeof payload !== 'object') {
    fail('EXPORT_PAYLOAD_INVALID', 'Export payload is missing or invalid')
  }

  const companies = payload.companies || []
  const roles = payload.roles || []
  const users = payload.users || []
  const activeUsers = users.filter((u) => String(u.status || '').toLowerCase() === 'active')

  if (companies.length !== EXPECTED_COMPANIES) {
    fail(
      'COMPANY_COUNT_MISMATCH',
      `Expected ${EXPECTED_COMPANIES} company, found ${companies.length}`,
    )
  }
  if (roles.length !== EXPECTED_ROLES) {
    fail(
      'ROLE_COUNT_MISMATCH',
      `Expected ${EXPECTED_ROLES} roles, found ${roles.length}`,
    )
  }
  if (users.length !== EXPECTED_ACTIVE_USERS || activeUsers.length !== EXPECTED_ACTIVE_USERS) {
    fail(
      'ACTIVE_USER_COUNT_MISMATCH',
      `Expected ${EXPECTED_ACTIVE_USERS} active users, found users=${users.length} active=${activeUsers.length}`,
    )
  }
  if (!passwordGate.passed) {
    fail('PASSWORD_GATE_NOT_PASSED', 'Password gate must be PASSED')
  }
  if (!payload.passwordGate || payload.passwordGate.passed !== true) {
    fail('PASSWORD_GATE_NOT_EMBEDDED', 'Export payload passwordGate.passed must be true')
  }

  let hashValidCount = 0
  for (const user of users) {
    if (!isBcryptHashFormat(user.passwordHash)) {
      fail(
        'INVALID_PASSWORD_HASH',
        `User ${user.email || user._id || '(unknown)'} has missing or invalid bcrypt hash format`,
      )
    }
    hashValidCount += 1
  }

  return {
    companies: companies.length,
    roles: roles.length,
    users: users.length,
    activeUsers: activeUsers.length,
    hashValidCount,
  }
}

function writePrivateExport(outFile, payload) {
  const tmp = `${outFile}.tmp.${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'w' })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, outFile)
  fs.chmodSync(outFile, 0o600)
}

function main() {
  const backupDir = process.env.COMPASS_BACKUP_DIR || DEFAULT_BACKUP_DIR
  const outFile = process.env.EXPORT_OUT || DEFAULT_OUT_FILE

  const requiredFiles = [
    'mongodb_companies_backup.json',
    'mongodb_roles_backup.json',
    'mongodb_users_backup.json',
  ]
  for (const name of requiredFiles) {
    const full = path.join(backupDir, name)
    if (!fs.existsSync(full)) {
      fail('BACKUP_FILE_MISSING', `Missing required Compass backup file: ${full}`)
    }
  }

  const passwordGate = loadPasswordGateStatus()

  const payload = exportFromCompassBackupDir(backupDir, {
    expectedActiveUserCount: EXPECTED_ACTIVE_USERS,
    activeUsersOnly: true,
    passwordGate: {
      passed: passwordGate.passed,
      testedAt: passwordGate.testedAt,
      note: passwordGate.note,
    },
    companyActiveHints: {},
    source: `compass-backup-offline:${path.resolve(backupDir)}`,
  })

  const counts = validatePayload(payload, passwordGate)
  const resolvedOut = ensurePrivateOutputPath(outFile)
  writePrivateExport(resolvedOut, payload)

  // Safe summary only — never dump payload or secrets.
  process.stdout.write('Compass backup export: OK\n')
  process.stdout.write(`Companies: ${counts.companies}\n`)
  process.stdout.write(`Roles: ${counts.roles}\n`)
  process.stdout.write(`Active users: ${counts.activeUsers}\n`)
  process.stdout.write(`Valid bcrypt hashes: ${counts.hashValidCount}/${EXPECTED_ACTIVE_USERS}\n`)
  process.stdout.write(`Password gate: PASSED (testedAt=${passwordGate.testedAt || 'n/a'})\n`)
  process.stdout.write(`Output: ${resolvedOut}\n`)
  process.stdout.write('Permissions: directory 700, file 600\n')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`EXPORT_FAILED [${error.code || 'ERROR'}] ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { main }
