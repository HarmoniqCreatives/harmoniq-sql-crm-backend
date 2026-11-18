'use strict'

const { permissionKeys } = require('../../utils/enums')

const SQL_PERMISSION_SET = new Set(Object.values(permissionKeys))
const ALL_SQL_PERMISSIONS = Object.values(permissionKeys)

/**
 * Expands Mongo role permission arrays for Harmoniq SQL enforcement.
 * Does not use role seed defaults.
 *
 * Approved rules:
 * - users.manage → granular users.* (+ keep users.manage)
 * - roles.manage → granular roles.* + permissions.manage (+ keep roles.manage)
 * - meta.manage → also meta.view
 * - super_admin / isProtected → full SQL permission set
 * - unknown keys omitted and reported
 *
 * @param {string[]} mongoPermissions
 * @param {{ key?: string, isProtected?: boolean }} roleMeta
 * @returns {{ permissions: string[], omitted: string[], expandedFrom: string[] }}
 */
function mapRolePermissions(mongoPermissions, roleMeta = {}) {
  const input = Array.isArray(mongoPermissions) ? mongoPermissions : []
  const omitted = []
  const expandedFrom = []
  const out = new Set()

  const isSuperAdmin = roleMeta.isProtected === true || roleMeta.key === 'super_admin'
  if (isSuperAdmin) {
    return {
      permissions: [...ALL_SQL_PERMISSIONS],
      omitted: [],
      expandedFrom: ['super_admin_full_sql_set'],
    }
  }

  for (const raw of input) {
    const key = String(raw)
    if (key === permissionKeys.usersManage || key === 'users.manage') {
      expandedFrom.push('users.manage')
      out.add(permissionKeys.usersView)
      out.add(permissionKeys.usersCreate)
      out.add(permissionKeys.usersEdit)
      out.add(permissionKeys.usersDelete)
      out.add(permissionKeys.usersInvite)
      out.add(permissionKeys.usersManage)
      continue
    }
    if (key === permissionKeys.rolesManage || key === 'roles.manage') {
      expandedFrom.push('roles.manage')
      out.add(permissionKeys.rolesView)
      out.add(permissionKeys.rolesCreate)
      out.add(permissionKeys.rolesEdit)
      out.add(permissionKeys.rolesDelete)
      out.add(permissionKeys.permissionsManage)
      out.add(permissionKeys.rolesManage)
      continue
    }
    if (key === permissionKeys.metaManage || key === 'meta.manage') {
      expandedFrom.push('meta.manage')
      out.add(permissionKeys.metaManage)
      out.add(permissionKeys.metaView)
      continue
    }
    if (SQL_PERMISSION_SET.has(key)) {
      out.add(key)
      continue
    }
    omitted.push(key)
  }

  return {
    permissions: [...out].sort(),
    omitted,
    expandedFrom: [...new Set(expandedFrom)],
  }
}

function listSqlPermissionKeys() {
  return [...ALL_SQL_PERMISSIONS]
}

module.exports = {
  mapRolePermissions,
  listSqlPermissionKeys,
  SQL_PERMISSION_SET,
}
