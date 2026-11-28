const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')
const { isKnownPermission } = require('../config/permissions')
const { permissionKeys, roleKeys, roleScopes } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  isWithinLength,
  normalizeNameKey,
  readText,
} = require('../utils/helpers')
const { security } = require('../config/security')
const {
  assertCanAssignPermissions,
  hasPermission,
  presentPermissionMatrix,
  roleRank,
} = require('./accessService')
const { deriveIsDeleted, markRestored, markSoftDeleted } = require('../utils/softDelete')

/**
 * Role CRUD with system-role protection and permission-escalation guards.
 */

/**
 * @param {object} role
 * @param {{ userCount?: number }} [extras]
 * @returns {object}
 */
function presentRole(role, extras = {}) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description || '',
    permissions: role.permissions || [],
    scope: role.scope,
    isSystem: Boolean(role.isSystem),
    isProtected: Boolean(role.isProtected),
    userCount: extras.userCount || 0,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
    deletedAt: role.deletedAt || null,
    is_deleted: deriveIsDeleted(role),
    isDeleted: deriveIsDeleted(role),
  }
}

function readPermissions(body) {
  if (!body || !Array.isArray(body.permissions)) {
    return []
  }
  return [...new Set(body.permissions.map((value) => String(value)))]
}

/**
 * Hidden legacy aliases that the Roles UI matrix may omit on save.
 * Only keys already present on the role are re-attached (never auto-granted).
 */
const HIDDEN_LEGACY_PERMISSIONS = [
  permissionKeys.activitiesManage,
  permissionKeys.templatesManage,
  permissionKeys.communicationsSend,
  permissionKeys.auditView,
  permissionKeys.usersManage,
  permissionKeys.rolesManage,
]

/**
 * Validate a submitted permissions array for role update.
 * - Every submitted key must be known (`isKnownPermission`).
 * - Existing hidden legacy permissions are preserved when omitted from the payload.
 * - Legacy keys the role did not already have are never auto-added.
 * - Privilege-escalation checks apply only to newly added keys so existing
 *   legacy permissions can remain even when the actor does not hold them.
 *
 * @param {object} auth
 * @param {string[]} existingPermissions
 * @param {string[]} submittedPermissions
 * @returns {string[]}
 */
function resolveUpdatedPermissions(auth, existingPermissions, submittedPermissions) {
  const submitted = [...new Set(
    (Array.isArray(submittedPermissions) ? submittedPermissions : [])
      .map((value) => String(value)),
  )]
  const unknown = submitted.filter((key) => !isKnownPermission(key))
  if (unknown.length) {
    throw new AppError(errors.rolePermissionsInvalid, 400, 'APP_ERROR', { invalid: unknown })
  }

  const existing = (Array.isArray(existingPermissions) ? existingPermissions : [])
    .map((value) => String(value))
  const existingSet = new Set(existing)
  const submittedSet = new Set(submitted)

  // Re-attach hidden legacy keys the role already had but the UI omitted.
  const preservedLegacy = HIDDEN_LEGACY_PERMISSIONS.filter(
    (key) => existingSet.has(key) && !submittedSet.has(key),
  )

  const permissions = [...new Set([...submitted, ...preservedLegacy])]
  const newlyAdded = permissions.filter((key) => !existingSet.has(key))
  assertCanAssignPermissions(auth, newlyAdded)
  return permissions
}

/**
 * Lists company roles plus the permission matrix for the UI.
 *
 * @param {object} auth
 * @returns {Promise<{ roles: object[], permissionMatrix: object }>}
 */
async function listRoles(auth) {
  const { Role, User } = getModels()
  const roles = await Role.findAll({
    where: { companyId: auth.companyId },
    order: [['name', 'ASC']],
  })
  const counts = await User.findAll({
    where: { companyId: auth.companyId },
    attributes: [
      'roleId',
      [User.sequelize.fn('COUNT', User.sequelize.col('id')), 'userCount'],
    ],
    group: ['roleId'],
    raw: true,
  })
  const countMap = {}
  for (const row of counts) {
    countMap[row.roleId] = Number(row.userCount || 0)
  }
  return {
    roles: roles.map((role) => presentRole(role, { userCount: countMap[role.id] || 0 })),
    permissionMatrix: presentPermissionMatrix(),
  }
}

async function getRole(auth, roleId) {
  const { Role, User } = getModels()
  const role = await Role.findOne({ where: { id: roleId, companyId: auth.companyId } })
  if (!role) {
    throw new AppError(errors.roleNotFound, 404)
  }
  const userCount = await User.count({ where: { companyId: auth.companyId, roleId: role.id } })
  return {
    role: presentRole(role, { userCount }),
    permissionMatrix: presentPermissionMatrix(),
  }
}

/**
 * Creates a custom role. Permissions must be a subset of the actor's permissions.
 *
 * @param {object} auth
 * @param {object} body name, description?, key?, scope?, permissions[]
 * @returns {Promise<{ message: string, role: object }>}
 */
async function createRole(auth, body) {
  const { Role } = getModels()
  const name = readText(body, 'name')
  const description = readText(body, 'description')
  const keyRaw = readText(body, 'key') || normalizeNameKey(name)
  const scope = readText(body, 'scope').toUpperCase() || roleScopes.company
  const permissions = readPermissions(body)

  if (!name || !isWithinLength(name, security.nameMaxLength)) {
    throw new AppError(errors.roleNameRequired, 400)
  }
  if (!keyRaw) {
    throw new AppError(errors.roleKeyRequired, 400)
  }
  if (!Object.values(roleScopes).includes(scope)) {
    throw new AppError(errors.requestFailed, 400)
  }
  const unknownOnCreate = permissions.filter((key) => !isKnownPermission(key))
  if (unknownOnCreate.length) {
    throw new AppError(errors.rolePermissionsInvalid, 400, 'APP_ERROR', { invalid: unknownOnCreate })
  }
  assertCanAssignPermissions(auth, permissions)

  const roleKey = keyRaw.slice(0, 64)
  const deletedWithKey = await Role.scope('onlyDeleted').findOne({
    where: { companyId: auth.companyId, key: roleKey },
  })
  if (deletedWithKey) {
    throw new AppError(errors.roleKeyDeletedExists, 409)
  }

  try {
    const role = await Role.create({
      id: uuidv4(),
      companyId: auth.companyId,
      key: roleKey,
      name,
      description: description.slice(0, 500),
      permissions,
      scope,
      isSystem: false,
      isProtected: false,
    })
    return {
      message: messages.roleCreated,
      role: presentRole(role),
    }
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(errors.roleKeyTaken, 409)
    }
    throw error
  }
}

/**
 * Updates a non-protected role. Actors cannot edit their own role row.
 *
 * @param {object} auth
 * @param {string} roleId
 * @param {object} body
 * @returns {Promise<{ message: string, role: object }>}
 */
async function updateRole(auth, roleId, body) {
  const { Role } = getModels()
  const role = await Role.findOne({ where: { id: roleId, companyId: auth.companyId } })
  if (!role) {
    throw new AppError(errors.roleNotFound, 404)
  }
  if (role.key === roleKeys.superAdmin || role.isProtected) {
    throw new AppError(errors.cannotModifySuperAdmin, 403)
  }
  if (auth.roleId === role.id) {
    throw new AppError(errors.cannotEditOwnRole, 403)
  }
  if (roleRank(role) > roleRank(auth.role)) {
    throw new AppError(errors.privilegeEscalation, 403)
  }

  if (body.name !== undefined) {
    const name = readText(body, 'name')
    if (!name) {
      throw new AppError(errors.roleNameRequired, 400)
    }
    role.name = name
  }
  if (body.description !== undefined) {
    role.description = readText(body, 'description').slice(0, 500)
  }
  if (body.scope !== undefined) {
    const scope = readText(body, 'scope').toUpperCase()
    if (!Object.values(roleScopes).includes(scope)) {
      throw new AppError(errors.requestFailed, 400)
    }
    role.scope = scope
  }
  if (body.permissions !== undefined) {
    role.permissions = resolveUpdatedPermissions(
      auth,
      role.permissions || [],
      readPermissions(body),
    )
  }

  await role.save()
  return {
    message: messages.roleUpdated,
    role: presentRole(role),
  }
}

/**
 * Deletes a custom role that is not system/protected and has no assigned users.
 *
 * @param {object} auth
 * @param {string} roleId
 * @returns {Promise<{ message: string }>}
 */
async function deleteRole(auth, roleId) {
  const { Role, User } = getModels()
  const role = await Role.findOne({ where: { id: roleId, companyId: auth.companyId } })
  if (!role) {
    throw new AppError(errors.roleNotFound, 404)
  }
  if (role.isSystem || role.isProtected || role.key === roleKeys.superAdmin) {
    throw new AppError(errors.roleSystemProtected, 403)
  }
  if (roleRank(role) > roleRank(auth.role)) {
    throw new AppError(errors.privilegeEscalation, 403)
  }
  const userCount = await User.count({ where: { companyId: auth.companyId, roleId: role.id } })
  if (userCount > 0) {
    throw new AppError(errors.roleInUse, 409)
  }
  await markSoftDeleted(role, { userId: auth.userId })
  return { message: messages.roleDeleted }
}

/**
 * @param {object} auth
 */
async function listDeletedRoles(auth) {
  if (!hasPermission(auth, permissionKeys.recycleBinView)) {
    throw new AppError(errors.forbidden, 403)
  }
  const { Role } = getModels()
  const rows = await Role.unscoped().findAll({
    where: { companyId: auth.companyId, isDeleted: true },
    order: [['deletedAt', 'DESC']],
  })
  return rows.map((role) => presentRole(role))
}

/**
 * @param {object} auth
 * @param {string} roleId
 */
async function restoreRole(auth, roleId) {
  if (!hasPermission(auth, permissionKeys.recycleBinRestore)) {
    throw new AppError(errors.forbidden, 403)
  }
  const { Role } = getModels()
  const role = await Role.unscoped().findOne({
    where: { id: roleId, companyId: auth.companyId, isDeleted: true },
  })
  if (!role) {
    throw new AppError(errors.roleNotFound, 404)
  }
  // Unique (companyId, key) is held by this soft-deleted row — restore cannot collide with another active row.
  const conflict = await Role.findOne({
    where: { companyId: auth.companyId, key: role.key, isDeleted: false },
  })
  if (conflict && conflict.id !== role.id) {
    throw new AppError(
      `Cannot restore role "${role.key}": an active role already uses this key.`,
      409,
    )
  }
  await markRestored(role)
  return { message: messages.roleRestored, role: presentRole(role) }
}

module.exports = {
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  listDeletedRoles,
  restoreRole,
  presentRole,
  resolveUpdatedPermissions,
  readPermissions,
  HIDDEN_LEGACY_PERMISSIONS,
}
