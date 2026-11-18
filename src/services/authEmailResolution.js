'use strict'

const { AppError, errors } = require('../utils/errors')

/**
 * Resolves which company-scoped user an email refers to for pre-auth flows.
 *
 * Rules:
 * - 0 matches → null (caller returns generic success; no enumeration)
 * - 1 match, no companyId → that user
 * - 1 match, companyId provided → that user only if company matches; else null
 * - 2+ matches, no companyId → companyRequired (never pick the first)
 * - 2+ matches, companyId provided → matching user or null
 *
 * @param {Array<{ companyId: string }>} users
 * @param {string} companyId
 * @returns {{ user: object|null, requiresCompany: boolean }}
 */
function resolveUserAmongEmailMatches(users, companyId) {
  const list = Array.isArray(users) ? users : []
  if (list.length === 0) {
    return { user: null, requiresCompany: false }
  }
  if (list.length === 1) {
    if (companyId && list[0].companyId !== companyId) {
      return { user: null, requiresCompany: false }
    }
    return { user: list[0], requiresCompany: false }
  }
  if (!companyId) {
    return { user: null, requiresCompany: true }
  }
  const match = list.find((row) => row.companyId === companyId) || null
  return { user: match, requiresCompany: false }
}

/**
 * Loads users by email and applies resolveUserAmongEmailMatches.
 * Throws AppError(companyRequired) when multi-company and no companyId.
 *
 * @param {{ findAll: Function }} User
 * @param {string} email
 * @param {string} companyId
 * @param {object} [extraWhere]
 * @returns {Promise<object|null>}
 */
async function findUserForPreAuthEmail(User, email, companyId, extraWhere = {}) {
  const users = await User.findAll({
    where: { email, ...extraWhere },
  })
  const resolved = resolveUserAmongEmailMatches(users, companyId)
  if (resolved.requiresCompany) {
    throw new AppError(errors.companyRequired, 400, 'COMPANY_REQUIRED')
  }
  return resolved.user
}

module.exports = {
  findUserForPreAuthEmail,
  resolveUserAmongEmailMatches,
}
