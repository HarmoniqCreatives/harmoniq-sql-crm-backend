'use strict'

/**
 * Mongo export for Companies, Roles, Users only.
 *
 * SAFETY: Does not open a Mongo connection by itself.
 * Live export requires:
 *   - options.allowLiveExport === true
 *   - options.collections with { companies, roles, users } query helpers
 *
 * Prefer feeding synthetic/fixture documents via exportFromDocuments().
 */

const EXPORT_FIELDS = {
  company: [
    '_id', 'name', 'nameKey', 'timezone', 'baseCurrency', 'enabledCurrencies',
    'createdAt', 'updatedAt',
  ],
  role: [
    '_id', 'companyId', 'key', 'name', 'description', 'permissions', 'scope',
    'isSystem', 'isProtected', 'createdAt', 'updatedAt',
  ],
  user: [
    '_id', 'companyId', 'roleId', 'name', 'email', 'phone', 'passwordHash',
    'status', 'emailVerified', 'isInitialSuperAdmin', 'isPlatformOperator',
    'lastLoginAt', 'disabledAt', 'createdAt', 'updatedAt',
  ],
}

function pick(doc, fields) {
  const out = {}
  const source = typeof doc.toObject === 'function' ? doc.toObject({ getters: false }) : { ...doc }
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = source[field]
    } else if (field === '_id' && source.id != null) {
      out._id = source.id
    }
  }
  // Always include passwordHash presence for users without exposing in summaries elsewhere
  return out
}

/**
 * @param {{ companies: object[], roles: object[], users: object[], companyActiveHints?: object, passwordGate?: object }} docs
 */
function exportFromDocuments(docs) {
  const companies = (docs.companies || []).map((row) => pick(row, EXPORT_FIELDS.company))
  const roles = (docs.roles || []).map((row) => pick(row, EXPORT_FIELDS.role))
  const users = (docs.users || []).map((row) => pick(row, EXPORT_FIELDS.user))

  return {
    meta: {
      exportedAt: new Date().toISOString(),
      scope: ['companies', 'roles', 'users'],
      source: docs.source || 'documents',
    },
    counts: {
      companies: companies.length,
      roles: roles.length,
      users: users.length,
    },
    companies,
    roles,
    users,
    companyActiveHints: docs.companyActiveHints || {},
    passwordGate: docs.passwordGate || { passed: false },
  }
}

/**
 * Live Mongo export (disabled unless explicitly allowed).
 * collections: { Company, Role, User } mongoose models with .find().select().lean()
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
  const { Company, Role, User } = options.collections || {}
  if (!Company || !Role || !User) {
    throw new Error('Mongo collections not provided')
  }

  const companySelect = EXPORT_FIELDS.company.join(' ')
  const roleSelect = EXPORT_FIELDS.role.join(' ')
  // passwordHash is select:false on schema — force include
  const userSelect = `${EXPORT_FIELDS.user.filter((f) => f !== 'passwordHash').join(' ')} +passwordHash`

  const companies = await Company.find({}).select(companySelect).lean()
  const roles = await Role.find({}).select(roleSelect).lean()
  const users = await User.find({}).select(userSelect).lean()

  return exportFromDocuments({
    companies,
    roles,
    users,
    companyActiveHints: options.companyActiveHints || {},
    passwordGate: options.passwordGate || { passed: false },
    source: 'mongodb-live',
  })
}

module.exports = {
  EXPORT_FIELDS,
  exportFromDocuments,
  exportFromMongoLive,
}
