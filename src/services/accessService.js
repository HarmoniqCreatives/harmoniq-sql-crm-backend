const { getModels } = require('../models')
const { isKnownPermission, listPermissions } = require('../config/permissions')
const { roleAuthority, roleKeys } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')

/**
 * True when the role is a protected Super Admin (full privilege grantor).
 * @param {{ isProtected?: boolean, key?: string }|null|undefined} role
 * @returns {boolean}
 */
function isProtectedGrantor(role) {
  return Boolean(role && (role.isProtected || role.key === roleKeys.superAdmin))
}

/**
 * Returns the permission keys held by the authenticated role.
 * Protected Super Admin is treated as holding the full known registry
 * so they can grant any catalog key (e.g. `leads.bulk`) even if a stale
 * role row omitted newer keys from its JSON array.
 *
 * Feature access for Super Admin does **not** depend on this list —
 * use `hasPermission`, which bypasses the catalog entirely for grantors.
 *
 * @param {{ role?: { permissions?: string[], isProtected?: boolean, key?: string } }} auth
 * @returns {string[]}
 */
function authPermissions(auth) {
  if (!auth || !auth.role) {
    return []
  }
  if (isProtectedGrantor(auth.role)) {
    return listPermissions().map((row) => row.key)
  }
  if (!Array.isArray(auth.role.permissions)) {
    return []
  }
  return auth.role.permissions
}

/**
 * Checks whether the auth context may use a feature permission key.
 *
 * **Permanent FILOS rule:** protected Super Admin (`isProtected` or
 * `role.key === super_admin`) passes every current and future feature
 * permission — including keys not yet in the permission catalog.
 * New modules must call this helper (or `requirePermission`, which uses it)
 * and must never require manual Super Admin role-permission seeding.
 *
 * Does **not** bypass authentication, account/company status, or tenant
 * isolation — only feature permission gates.
 *
 * Frontend `hasPermission` mirrors this for UX only; server remains authoritative.
 *
 * @param {object} auth
 * @param {string} permissionKey
 * @returns {boolean}
 */
function hasPermission(auth, permissionKey) {
  if (!permissionKey) {
    return false
  }
  if (isProtectedGrantor(auth && auth.role)) {
    return true
  }
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
 * Protected Super Admin may grant any known registry permission (legacy parity).
 *
 * @param {object} auth
 * @param {string[]} permissions
 * @throws {AppError} 400 unknown permission, 403 escalation
 */
function assertCanAssignPermissions(auth, permissions) {
  const protectedGrantor = isProtectedGrantor(auth && auth.role)
  const held = new Set(authPermissions(auth))
  const unknown = []
  for (const key of permissions) {
    if (!isKnownPermission(key)) {
      unknown.push(key)
      continue
    }
    if (protectedGrantor) {
      continue
    }
    if (!held.has(key)) {
      throw new AppError(errors.privilegeEscalation, 403)
    }
  }
  if (unknown.length) {
    throw new AppError(errors.rolePermissionsInvalid, 400, 'APP_ERROR', { invalid: unknown })
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
  isProtectedGrantor,
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
