const { getModels } = require('../models')
const { assertSessionActive, verifyAccessToken } = require('../services/tokenService')
const { companyStatuses, userStatuses } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { asyncHandler } = require('./asyncHandler')

/**
 * Extracts a Bearer access token from the Authorization header.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function readBearerToken(req) {
  const header = req.get('authorization') || ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return ''
  }
  return header.slice(7).trim()
}

/**
 * Requires a valid access JWT and an active refresh session.
 *
 * Loads user, company, and role from the database on every request so
 * permission changes take effect without waiting for token expiry.
 * Sets `req.auth` with `{ userId, companyId, roleId, sessionId, user, role, company }`.
 * Never trusts client-supplied companyId.
 */
const requireAuth = asyncHandler(async (req, res, next) => {
  const token = readBearerToken(req)
  if (!token) {
    throw new AppError(errors.unauthorized, 401)
  }
  const payload = verifyAccessToken(token)
  await assertSessionActive(payload.sid, payload.sub, payload.companyId)

  const { User, Role, Company } = getModels()
  const user = await User.findByPk(payload.sub)
  if (!user || user.companyId !== payload.companyId) {
    throw new AppError(errors.unauthorized, 401)
  }
  if (user.status !== userStatuses.active || !user.emailVerified) {
    throw new AppError(errors.unauthorized, 401)
  }
  const company = await Company.findByPk(user.companyId)
  if (!company || company.status !== companyStatuses.active) {
    throw new AppError(errors.unauthorized, 401)
  }
  const role = await Role.findByPk(user.roleId)
  if (!role || role.companyId !== user.companyId) {
    throw new AppError(errors.unauthorized, 401)
  }

  req.auth = {
    userId: user.id,
    companyId: user.companyId,
    roleId: role.id,
    sessionId: payload.sid,
    user,
    role,
    company,
  }
  next()
})

/**
 * Requires that `req.auth.role.permissions` contains the given key.
 *
 * @param {string} permission e.g. `users.edit`
 * @returns {import('express').RequestHandler}
 */
function requirePermission(permission) {
  return asyncHandler(async (req, res, next) => {
    if (!req.auth || !req.auth.role) {
      throw new AppError(errors.unauthorized, 401)
    }
    const permissions = req.auth.role.permissions || []
    if (!permissions.includes(permission)) {
      throw new AppError(errors.forbidden, 403)
    }
    next()
  })
}

/**
 * Requires at least one of the listed permissions (useful for shared list endpoints).
 *
 * @param {string[]} permissionList
 * @returns {import('express').RequestHandler}
 */
function requireAnyPermission(permissionList) {
  return asyncHandler(async (req, res, next) => {
    if (!req.auth || !req.auth.role) {
      throw new AppError(errors.unauthorized, 401)
    }
    const permissions = req.auth.role.permissions || []
    const allowed = permissionList.some((key) => permissions.includes(key))
    if (!allowed) {
      throw new AppError(errors.forbidden, 403)
    }
    next()
  })
}

module.exports = { requireAuth, requirePermission, requireAnyPermission }
