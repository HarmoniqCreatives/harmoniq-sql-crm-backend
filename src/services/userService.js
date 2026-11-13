const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { security } = require('../config/security')
const { getModels } = require('../models')
const { permissionKeys, userStatuses } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  addHours,
  createSecretToken,
  hashPassword,
  hashSecret,
  isEmail,
  isInternationalPhone,
  isWithinLength,
  normalizeEmail,
  normalizePhone,
  readText,
  requirePassword,
} = require('../utils/helpers')
const {
  assertCanAssignRole,
  assertCanModifyUser,
  isProtectedSuperAdminUser,
  loadCompanyBranch,
  loadCompanyRole,
  loadCompanyTeam,
} = require('./accessService')
const { revokeAllUserSessions } = require('./tokenService')

/**
 * User directory service. All queries are scoped by `auth.companyId`.
 * Protected Super Admin accounts cannot be demoted/deactivated by others.
 */

/**
 * Public user DTO for directory/detail responses (no passwordHash).
 *
 * @param {object} user
 * @param {object} [extras]
 * @returns {object}
 */
function presentUser(user, extras = {}) {
  const role = extras.role || user.Role || null
  const branch = extras.branch || user.Branch || null
  const team = extras.team || user.Team || null
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    status: user.status,
    emailVerified: user.emailVerified,
    isInitialSuperAdmin: Boolean(user.isInitialSuperAdmin),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    role: role ? {
      id: role.id,
      key: role.key,
      name: role.name,
      scope: role.scope,
      isProtected: Boolean(role.isProtected),
    } : null,
    branch: branch ? { id: branch.id, name: branch.name } : null,
    team: team ? { id: team.id, name: team.name, branchId: team.branchId } : null,
  }
}

function parseListQuery(query) {
  const page = Math.max(1, Number(query.page || 1) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20) || 20))
  const search = String(query.search || '').trim()
  const roleId = String(query.roleId || '').trim()
  const status = String(query.status || '').trim().toUpperCase()
  const branchId = String(query.branchId || '').trim()
  const teamId = String(query.teamId || '').trim()
  const sort = String(query.sort || 'name').trim()
  const direction = String(query.direction || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
  return {
    page,
    limit,
    offset: (page - 1) * limit,
    search,
    roleId,
    status,
    branchId,
    teamId,
    sort,
    direction,
  }
}

/**
 * Server-side paginated user listing with search, filters, and sort.
 *
 * @param {object} auth
 * @param {object} query page, limit, search, roleId, status, branchId, teamId, sort, direction
 * @returns {Promise<{ users: object[], page: number, limit: number, total: number }>}
 */
async function listUsers(auth, query) {
  const { User, Role, Branch, Team } = getModels()
  const params = parseListQuery(query)
  const where = { companyId: auth.companyId }
  if (params.roleId) {
    where.roleId = params.roleId
  }
  if (params.status && Object.values(userStatuses).includes(params.status)) {
    where.status = params.status
  }
  if (params.branchId) {
    where.branchId = params.branchId
  }
  if (params.teamId) {
    where.teamId = params.teamId
  }
  if (params.search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${params.search}%` } },
      { email: { [Op.like]: `%${params.search}%` } },
      { phone: { [Op.like]: `%${params.search}%` } },
    ]
  }

  let order = [['name', params.direction]]
  if (params.sort === 'createdAt' || params.sort === 'created') {
    order = [['createdAt', params.direction]]
  } else if (params.sort === 'status') {
    order = [['status', params.direction], ['name', 'ASC']]
  }

  const result = await User.findAndCountAll({
    where,
    include: [
      { model: Role, attributes: ['id', 'key', 'name', 'scope', 'isProtected'] },
      { model: Branch, attributes: ['id', 'name'] },
      { model: Team, attributes: ['id', 'name', 'branchId'] },
    ],
    order,
    limit: params.limit,
    offset: params.offset,
  })

  return {
    users: result.rows.map((row) => presentUser(row)),
    page: params.page,
    limit: params.limit,
    total: result.count,
  }
}

/**
 * Loads one user in the auth company or returns 404.
 *
 * @param {object} auth
 * @param {string} userId
 * @returns {Promise<{ user: object }>}
 */
async function getUser(auth, userId) {
  const { User, Role, Branch, Team } = getModels()
  const user = await User.findOne({
    where: { id: userId, companyId: auth.companyId },
    include: [
      { model: Role, attributes: ['id', 'key', 'name', 'scope', 'isProtected', 'permissions'] },
      { model: Branch, attributes: ['id', 'name'] },
      { model: Team, attributes: ['id', 'name', 'branchId'] },
    ],
  })
  if (!user) {
    throw new AppError(errors.userNotFound, 404)
  }
  return { user: presentUser(user) }
}

/**
 * Creates an active verified user directly (admin path; not invitation).
 * Name is the person's name—never the company name.
 *
 * @param {object} auth
 * @param {object} body name, email, phone?, roleId, branchId?, teamId?, password
 * @returns {Promise<{ message: string, user: object }>}
 */
async function createUser(auth, body) {
  const { User } = getModels()
  const name = readText(body, 'name')
  const email = normalizeEmail(readText(body, 'email'))
  const phoneRaw = readText(body, 'phone') || readText(body, 'mobile')
  const roleId = readText(body, 'roleId')
  const branchId = readText(body, 'branchId') || null
  const teamId = readText(body, 'teamId') || null
  const password = typeof body.password === 'string' ? body.password : ''

  if (!name || !isWithinLength(name, security.nameMaxLength)) {
    throw new AppError(errors.nameRequired, 400)
  }
  if (!email || !isEmail(email)) {
    throw new AppError(errors.emailInvalid, 400)
  }
  if (!roleId) {
    throw new AppError(errors.roleNotFound, 400)
  }
  requirePassword(password)

  const role = await loadCompanyRole(auth.companyId, roleId)
  assertCanAssignRole(auth, role)
  const branch = await loadCompanyBranch(auth.companyId, branchId)
  const team = await loadCompanyTeam(auth.companyId, teamId, branch ? branch.id : branchId)

  let phone = null
  if (phoneRaw) {
    phone = normalizePhone(phoneRaw)
    if (!isInternationalPhone(phone)) {
      throw new AppError(errors.phoneInvalid, 400)
    }
  }

  try {
    const user = await User.create({
      id: uuidv4(),
      companyId: auth.companyId,
      roleId: role.id,
      branchId: branch ? branch.id : null,
      teamId: team ? team.id : null,
      name,
      email,
      phone,
      passwordHash: await hashPassword(password),
      status: userStatuses.active,
      emailVerified: true,
      isInitialSuperAdmin: false,
    })
    return {
      message: messages.userCreated,
      user: (await getUser(auth, user.id)).user,
    }
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(errors.emailTaken, 409)
    }
    throw error
  }
}

/**
 * Updates profile, role, branch/team, or status with privilege checks.
 * Users cannot change their own role. Deactivate revokes sessions.
 *
 * @param {object} auth
 * @param {string} userId
 * @param {object} body
 * @returns {Promise<{ message: string, user: object }>}
 */
async function updateUser(auth, userId, body) {
  const { User, Role } = getModels()
  const user = await User.findOne({ where: { id: userId, companyId: auth.companyId } })
  if (!user) {
    throw new AppError(errors.userNotFound, 404)
  }
  const currentRole = await Role.findByPk(user.roleId)
  assertCanModifyUser(auth, user, currentRole)

  const isSelf = auth.userId === user.id
  const name = body.name !== undefined ? readText(body, 'name') : user.name
  const phoneRaw = body.phone !== undefined || body.mobile !== undefined
    ? (readText(body, 'phone') || readText(body, 'mobile'))
    : (user.phone || '')
  const roleId = body.roleId !== undefined ? readText(body, 'roleId') : user.roleId
  const branchId = body.branchId !== undefined ? (readText(body, 'branchId') || null) : user.branchId
  const teamId = body.teamId !== undefined ? (readText(body, 'teamId') || null) : user.teamId
  const status = body.status !== undefined ? String(body.status).toUpperCase() : user.status

  if (!name || !isWithinLength(name, security.nameMaxLength)) {
    throw new AppError(errors.nameRequired, 400)
  }
  if (isSelf && roleId !== user.roleId) {
    throw new AppError(errors.cannotEditOwnRole, 403)
  }

  let nextRole = currentRole
  if (roleId !== user.roleId) {
    nextRole = await loadCompanyRole(auth.companyId, roleId)
    assertCanAssignRole(auth, nextRole)
  }

  if (status !== user.status) {
    if (!Object.values(userStatuses).includes(status)) {
      throw new AppError(errors.invalidStatus, 400)
    }
    if (isProtectedSuperAdminUser(user, currentRole) && status === userStatuses.disabled) {
      throw new AppError(errors.cannotModifySuperAdmin, 403)
    }
  }

  const branch = await loadCompanyBranch(auth.companyId, branchId)
  const team = await loadCompanyTeam(auth.companyId, teamId, branch ? branch.id : branchId)

  let phone = user.phone
  if (body.phone !== undefined || body.mobile !== undefined) {
    if (!phoneRaw) {
      phone = null
    } else {
      phone = normalizePhone(phoneRaw)
      if (!isInternationalPhone(phone)) {
        throw new AppError(errors.phoneInvalid, 400)
      }
    }
  }

  user.name = name
  user.phone = phone
  user.roleId = nextRole.id
  user.branchId = branch ? branch.id : null
  user.teamId = team ? team.id : null
  user.status = status
  if (status === userStatuses.disabled) {
    user.disabledAt = new Date()
    await revokeAllUserSessions(user.id)
  } else if (status === userStatuses.active) {
    user.disabledAt = null
  }
  await user.save()

  return {
    message: messages.userUpdated,
    user: (await getUser(auth, user.id)).user,
  }
}

async function setUserActive(auth, userId, active) {
  return updateUser(auth, userId, {
    status: active ? userStatuses.active : userStatuses.disabled,
  })
}

/**
 * Starts an admin-initiated password reset. Returns a one-time link; does not email.
 * Raw token is returned once for the admin to share; only the hash is stored.
 *
 * @param {object} auth
 * @param {string} userId
 * @param {string} publicFrontendBase
 * @returns {Promise<{ message: string, resetUrl: string, expiresAt: Date }>}
 */
async function createAdminPasswordReset(auth, userId, publicFrontendBase) {
  const { User, Role } = getModels()

  const user = await User.findOne({ where: { id: userId, companyId: auth.companyId } })
  if (!user) {
    throw new AppError(errors.userNotFound, 404)
  }
  const role = await Role.findByPk(user.roleId)
  assertCanModifyUser(auth, user, role)

  const token = createSecretToken()
  const expiresAt = addHours(new Date(), security.passwordResetHours || security.resetHours || 1)
  user.resetTokenHash = hashSecret(token)
  user.resetExpiresAt = expiresAt
  await user.save()

  const base = String(publicFrontendBase || '').replace(/\/+$/, '')
  const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`
  return {
    message: messages.passwordResetStarted,
    resetUrl,
    expiresAt,
  }
}

async function listBranches(auth) {
  const { Branch } = getModels()
  const rows = await Branch.findAll({
    where: { companyId: auth.companyId, isActive: true },
    order: [['name', 'ASC']],
    attributes: ['id', 'name', 'timezone'],
  })
  return { branches: rows }
}

async function listTeams(auth, query = {}) {
  const { Team } = getModels()
  const where = { companyId: auth.companyId, isActive: true }
  if (query.branchId) {
    where.branchId = String(query.branchId)
  }
  const rows = await Team.findAll({
    where,
    order: [['name', 'ASC']],
    attributes: ['id', 'name', 'branchId'],
  })
  return { teams: rows }
}

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  setUserActive,
  createAdminPasswordReset,
  listBranches,
  listTeams,
  presentUser,
  permissionKeys,
}
