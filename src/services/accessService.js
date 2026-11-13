const { getModels } = require('../models')
const { isKnownPermission, listPermissions } = require('../config/permissions')
const { roleAuthority, roleKeys } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')

/**
 * Returns the permission keys held by the authenticated role.
 *
 * @param {{ role?: { permissions?: string[] } }} auth
 * @returns {string[]}
 */
function authPermissions(auth) {
  if (!auth || !auth.role || !Array.isArray(auth.role.permissions)) {
    return []
  }
  return auth.role.permissions
}

/**
 * Checks whether the auth context includes a permission key.
 *
 * Frontend checks are UX only; this helper backs server-side enforcement.
 *
 * @param {object} auth
 * @param {string} permissionKey
 * @returns {boolean}
 */
function hasPermission(auth, permissionKey) {
  return authPermissions(auth).includes(permissionKey)
}

/**
 * Numeric authority rank for privilege-escalation comparisons.
 * Custom roles rank below seeded system roles.
 *
 * @param {{ key?: string }|null} role
 * @returns {number}
 */
function roleRank(role) {
  if (!role) {
    return 0
  }
  if (typeof roleAuthority[role.key] === 'number') {
    return roleAuthority[role.key]
  }
  return 10
}

/**
 * Ensures every permission in a set is known and already held by the actor.
 * Prevents granting privileges the actor does not possess.
 *
 * @param {object} auth
 * @param {string[]} permissions
 * @throws {AppError} 400 unknown permission, 403 escalation
 */
function assertCanAssignPermissions(auth, permissions) {
  const held = new Set(authPermissions(auth))
  for (const key of permissions) {
    if (!isKnownPermission(key) && !held.has(key)) {
      throw new AppError(errors.rolePermissionsInvalid, 400)
    }
    if (!held.has(key)) {
      throw new AppError(errors.privilegeEscalation, 403)
    }
  }
}

/**
 * Validates that a target role belongs to the company and is not above the actor.
 *
 * @param {object} auth
 * @param {object} targetRole
 * @throws {AppError}
 */
function assertCanAssignRole(auth, targetRole) {
  if (!targetRole || targetRole.companyId !== auth.companyId) {
    throw new AppError(errors.roleNotFound, 404)
  }
  if (targetRole.key === roleKeys.superAdmin && auth.role.key !== roleKeys.superAdmin) {
    throw new AppError(errors.cannotAssignSuperAdmin, 403)
  }
  if (roleRank(targetRole) > roleRank(auth.role)) {
    throw new AppError(errors.privilegeEscalation, 403)
  }
  assertCanAssignPermissions(auth, targetRole.permissions || [])
}

/**
 * True when the user is the initial Super Admin or holds a protected Super Admin role.
 *
 * @param {object|null} user
 * @param {object|null} role
 * @returns {boolean}
 */
function isProtectedSuperAdminUser(user, role) {
  if (user && user.isInitialSuperAdmin) {
    return true
  }
  if (role && (role.isProtected || role.key === roleKeys.superAdmin)) {
    return true
  }
  return false
}

/**
 * Blocks other users from modifying a protected Super Admin account.
 *
 * @param {object} auth
 * @param {object} targetUser
 * @param {object|null} targetRole
 * @throws {AppError} 404 wrong tenant, 403 protected
 */
function assertCanModifyUser(auth, targetUser, targetRole) {
  if (!targetUser || targetUser.companyId !== auth.companyId) {
    throw new AppError(errors.userNotFound, 404)
  }
  if (isProtectedSuperAdminUser(targetUser, targetRole) && auth.userId !== targetUser.id) {
    throw new AppError(errors.cannotModifySuperAdmin, 403)
  }
}

/**
 * Loads a role that must belong to the authenticated company.
 *
 * @param {string} companyId
 * @param {string} roleId
 * @returns {Promise<object>}
 */
async function loadCompanyRole(companyId, roleId) {
  const { Role } = getModels()
  const role = await Role.findOne({ where: { id: roleId, companyId } })
  if (!role) {
    throw new AppError(errors.roleNotFound, 404)
  }
  return role
}

/**
 * Loads a branch in the company, or null when unset.
 *
 * @param {string} companyId
 * @param {string|null} branchId
 * @returns {Promise<object|null>}
 */
async function loadCompanyBranch(companyId, branchId) {
  if (!branchId) {
    return null
  }
  const { Branch } = getModels()
  const branch = await Branch.findOne({ where: { id: branchId, companyId } })
  if (!branch) {
    throw new AppError(errors.branchNotFound, 404)
  }
  return branch
}

/**
 * Loads a team in the company and optionally verifies it belongs to `branchId`.
 *
 * @param {string} companyId
 * @param {string|null} teamId
 * @param {string|null} [branchId]
 * @returns {Promise<object|null>}
 */
async function loadCompanyTeam(companyId, teamId, branchId) {
  if (!teamId) {
    return null
  }
  const { Team } = getModels()
  const team = await Team.findOne({ where: { id: teamId, companyId } })
  if (!team) {
    throw new AppError(errors.teamNotFound, 404)
  }
  if (branchId && team.branchId !== branchId) {
    throw new AppError(errors.teamBranchMismatch, 400)
  }
  return team
}

/**
 * Groups the permission registry by module for the roles UI matrix.
 *
 * @returns {Record<string, Array<{key:string,module:string,description:string}>>}
 */
function presentPermissionMatrix() {
  const grouped = {}
  for (const row of listPermissions()) {
    if (!grouped[row.module]) {
      grouped[row.module] = []
    }
    grouped[row.module].push(row)
  }
  return grouped
}

module.exports = {
  authPermissions,
  hasPermission,
  roleRank,
  assertCanAssignPermissions,
  assertCanAssignRole,
  isProtectedSuperAdminUser,
  assertCanModifyUser,
  loadCompanyRole,
  loadCompanyBranch,
  loadCompanyTeam,
  presentPermissionMatrix,
}
