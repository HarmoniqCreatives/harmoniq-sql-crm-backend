'use strict'

const { AppError, errors } = require('../utils/errors')

const INITIAL_SUPER_ADMIN_UNIQUE_INDEX = 'users_initial_super_admin_company_uidx'

/**
 * True when a unique-constraint failure is the one-initial-SA-per-company index.
 */
function isInitialSuperAdminConflict(error) {
  if (!error || error.name !== 'SequelizeUniqueConstraintError') return false
  const text = `${error?.parent?.sqlMessage || ''} ${error?.message || ''}`
  if (text.includes(INITIAL_SUPER_ADMIN_UNIQUE_INDEX) || text.includes('initialSuperAdminCompanyKey')) {
    return true
  }
  const fields = error.fields || {}
  return Object.prototype.hasOwnProperty.call(fields, 'initialSuperAdminCompanyKey')
}

function throwIfInitialSuperAdminConflict(error) {
  if (isInitialSuperAdminConflict(error)) {
    throw new AppError(errors.initialSuperAdminTaken, 409, 'INITIAL_SUPER_ADMIN_TAKEN')
  }
}

/**
 * Read-only detection of companies with more than one initial Super Admin.
 * Does not modify records.
 *
 * @param {{ findAll: Function }} User
 * @returns {Promise<Array<{ companyId: string, count: number, userIds: string[], emails: string[] }>>}
 */
async function detectDuplicateInitialSuperAdmins(User) {
  const rows = await User.findAll({
    where: { isInitialSuperAdmin: true },
    attributes: ['id', 'companyId', 'email', 'createdAt'],
    order: [['companyId', 'ASC'], ['createdAt', 'ASC']],
  })
  const byCompany = new Map()
  for (const row of rows) {
    const key = String(row.companyId)
    if (!byCompany.has(key)) byCompany.set(key, [])
    byCompany.get(key).push(row)
  }
  const duplicates = []
  for (const [companyId, group] of byCompany) {
    if (group.length < 2) continue
    duplicates.push({
      companyId,
      count: group.length,
      userIds: group.map((row) => row.id),
      emails: group.map((row) => row.email),
    })
  }
  return duplicates
}

module.exports = {
  INITIAL_SUPER_ADMIN_UNIQUE_INDEX,
  detectDuplicateInitialSuperAdmins,
  isInitialSuperAdminConflict,
  throwIfInitialSuperAdminConflict,
}
