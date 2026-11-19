'use strict'

/**
 * Mongo export for Companies, Branches, Teams, Roles, Users.
 *
 * SAFETY: Does not open a Mongo connection by itself.
 * Live export requires:
 *   - options.allowLiveExport === true
 *   - options.collections with query helpers
 *
 * Prefer feeding synthetic/fixture documents via exportFromDocuments().
 */

const EXPORT_FIELDS = {
  company: [
    '_id', 'name', 'nameKey', 'timezone', 'baseCurrency', 'enabledCurrencies',
    'createdAt', 'updatedAt',
  ],
  branch: [
    '_id', 'companyId', 'name', 'nameKey', 'timezone', 'isActive',
    'createdAt', 'updatedAt',
  ],
  team: [
    '_id', 'companyId', 'branchId', 'name', 'nameKey', 'managerUserId', 'isActive',
    'createdAt', 'updatedAt',
  ],
  role: [
    '_id', 'companyId', 'key', 'name', 'description', 'permissions', 'scope',
    'isSystem', 'isProtected', 'createdAt', 'updatedAt',
  ],
  user: [
    '_id', 'companyId', 'roleId', 'branchId', 'teamId', 'name', 'email', 'phone',
    'passwordHash', 'status', 'emailVerified', 'isInitialSuperAdmin', 'isPlatformOperator',
    'lastLoginAt', 'disabledAt', 'createdAt', 'updatedAt',
  ],
}

function unwrapExtendedJsonValue(value) {
  if (value == null) return value
  if (typeof value !== 'object') return value
  if (Object.prototype.hasOwnProperty.call(value, '$oid')) return String(value.$oid)
  if (Object.prototype.hasOwnProperty.call(value, '$date')) {
    return new Date(value.$date)
  }
  if (Array.isArray(value)) return value.map(unwrapExtendedJsonValue)
  return value
}

function normalizeMongoDocument(doc) {
  const source = typeof doc.toObject === 'function' ? doc.toObject({ getters: false }) : { ...doc }
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = unwrapExtendedJsonValue(value)
  }
  if (out._id != null) out._id = String(out._id)
  if (out.companyId != null) out.companyId = String(out.companyId)
  if (out.roleId != null) out.roleId = String(out.roleId)
  if (out.branchId != null) out.branchId = String(out.branchId)
  if (out.teamId != null) out.teamId = String(out.teamId)
  if (out.managerUserId != null) out.managerUserId = String(out.managerUserId)
  return out
}

function pick(doc, fields) {
  const out = {}
  const source = normalizeMongoDocument(doc)
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = source[field]
    } else if (field === '_id' && source.id != null) {
      out._id = String(source.id)
    }
  }
  return out
}

/**
 * Hard gate used by production cutover: refuse incomplete active-user exports.
 */
function assertActiveUserCount(users, expectedActiveUserCount) {
  if (expectedActiveUserCount == null) return
  const expected = Number(expectedActiveUserCount)
  const active = (users || []).filter((u) => String(u.status || '').toLowerCase() === 'active')
  if (active.length !== expected) {
    const err = new Error(
      `ACTIVE_USER_COUNT_MISMATCH: expected ${expected} active users, found ${active.length} (total ${users.length})`,
    )
    err.code = 'ACTIVE_USER_COUNT_MISMATCH'
    err.expected = expected
    err.actual = active.length
    err.total = users.length
    throw err
  }
}

/**
 * @param {{ companies: object[], branches?: object[], teams?: object[], roles: object[], users: object[], companyActiveHints?: object, passwordGate?: object, activeUsersOnly?: boolean, expectedActiveUserCount?: number, source?: string }} docs
 */
function exportFromDocuments(docs) {
  let usersIn = docs.users || []
  if (docs.activeUsersOnly === true) {
    usersIn = usersIn.filter((u) => String(u.status || '').toLowerCase() === 'active')
  }

  const companies = (docs.companies || []).map((row) => pick(row, EXPORT_FIELDS.company))
  const branches = (docs.branches || []).map((row) => pick(row, EXPORT_FIELDS.branch))
  const teams = (docs.teams || []).map((row) => pick(row, EXPORT_FIELDS.team))
  const roles = (docs.roles || []).map((row) => pick(row, EXPORT_FIELDS.role))
  const users = usersIn.map((row) => pick(row, EXPORT_FIELDS.user))

  assertActiveUserCount(users, docs.expectedActiveUserCount)

  return {
    meta: {
      exportedAt: new Date().toISOString(),
      scope: ['companies', 'branches', 'teams', 'roles', 'users'],
      source: docs.source || 'documents',
      activeUsersOnly: Boolean(docs.activeUsersOnly),
      expectedActiveUserCount:
        docs.expectedActiveUserCount == null ? null : Number(docs.expectedActiveUserCount),
    },
    counts: {
      companies: companies.length,
      branches: branches.length,
      teams: teams.length,
      roles: roles.length,
      users: users.length,
      activeUsers: users.filter((u) => String(u.status || '').toLowerCase() === 'active').length,
    },
    companies,
    branches,
    teams,
    roles,
    users,
    companyActiveHints: docs.companyActiveHints || {},
    passwordGate: docs.passwordGate || { passed: false },
  }
}

/**
 * Load MongoDB Compass Extended JSON backups (companies/roles/users[/branches/teams]).
 * Use this when live MONGODB_URI points at a non-production clone.
 */
function exportFromCompassBackupDir(backupDir, options = {}) {
  const fs = require('fs')
  const path = require('path')
  const dir = path.resolve(backupDir)

  function readJsonArray(fileName, required) {
    const full = path.join(dir, fileName)
    if (!fs.existsSync(full)) {
      if (required) throw new Error(`Missing backup file: ${full}`)
      return []
    }
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`Backup must be a JSON array: ${full}`)
    return parsed
  }

  return exportFromDocuments({
    companies: readJsonArray(options.companiesFile || 'mongodb_companies_backup.json', true),
    roles: readJsonArray(options.rolesFile || 'mongodb_roles_backup.json', true),
    users: readJsonArray(options.usersFile || 'mongodb_users_backup.json', true),
    branches: readJsonArray(options.branchesFile || 'mongodb_branches_backup.json', false),
    teams: readJsonArray(options.teamsFile || 'mongodb_teams_backup.json', false),
    companyActiveHints: options.companyActiveHints || {},
    passwordGate: options.passwordGate || { passed: false },
    activeUsersOnly: options.activeUsersOnly !== false,
    expectedActiveUserCount: options.expectedActiveUserCount,
    source: options.source || `compass-backup:${dir}`,
  })
}

/**
 * Live Mongo export (disabled unless explicitly allowed).
 * collections: { Company, Branch, Team, Role, User } mongoose models
 */
async function exportFromMongoLive(options = {}) {
  if (options.allowLiveExport !== true) {
    const err = new Error('LIVE_MONGO_EXPORT_BLOCKED')
    err.code = 'LIVE_MONGO_EXPORT_BLOCKED'
    throw err
  }
  if (process.env.MIGRATION_ALLOW_LIVE_MONGO !== '1') {
    const err = new Error('LIVE_MONGO_EXPORT_ENV_BLOCKED')
    err.code = 'LIVE_MONGO_EXPORT_ENV_BLOCKED'
    throw err
  }
  const { Company, Branch, Team, Role, User } = options.collections || {}
  if (!Company || !Role || !User) {
    throw new Error('Mongo collections not provided (Company, Role, User required)')
  }

  const companySelect = EXPORT_FIELDS.company.join(' ')
  const branchSelect = EXPORT_FIELDS.branch.join(' ')
  const teamSelect = EXPORT_FIELDS.team.join(' ')
  const roleSelect = EXPORT_FIELDS.role.join(' ')
  const userSelect = `${EXPORT_FIELDS.user.filter((f) => f !== 'passwordHash').join(' ')} +passwordHash`

  const companies = await Company.find({}).select(companySelect).lean()
  const branches = Branch ? await Branch.find({}).select(branchSelect).lean() : []
  const teams = Team ? await Team.find({}).select(teamSelect).lean() : []
  const roles = await Role.find({}).select(roleSelect).lean()
  const userQuery = options.activeUsersOnly === false ? {} : { status: 'active' }
  const users = await User.find(userQuery).select(userSelect).lean()

  return exportFromDocuments({
    companies,
    branches,
    teams,
    roles,
    users,
    companyActiveHints: options.companyActiveHints || {},
    passwordGate: options.passwordGate || { passed: false },
    activeUsersOnly: options.activeUsersOnly !== false,
    expectedActiveUserCount: options.expectedActiveUserCount,
    source: options.source || 'mongo-live',
  })
}

module.exports = {
  EXPORT_FIELDS,
  exportFromDocuments,
  exportFromMongoLive,
  exportFromCompassBackupDir,
  assertActiveUserCount,
  normalizeMongoDocument,
}
