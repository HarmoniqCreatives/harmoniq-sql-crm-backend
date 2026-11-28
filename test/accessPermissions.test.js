const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  assertCanAssignPermissions,
  hasPermission,
  isProtectedGrantor,
} = require('../src/services/accessService')
const { AppError, errors } = require('../src/utils/errors')
const { permissionKeys, roleKeys } = require('../src/utils/enums')

test('protected Super Admin is a grantor even with empty permissions array', () => {
  const auth = {
    role: {
      key: roleKeys.superAdmin,
      isProtected: true,
      permissions: [],
    },
  }
  assert.equal(isProtectedGrantor(auth.role), true)
  assert.equal(hasPermission(auth, permissionKeys.leadsBulk), true)
  assert.equal(hasPermission(auth, 'future.feature.not_in_catalog'), true)
  assert.doesNotThrow(() => {
    assertCanAssignPermissions(auth, [permissionKeys.leadsBulk, permissionKeys.leadsBulkAssign])
  })
})

test('Super Admin still cannot assign unknown keys into other roles', () => {
  const auth = {
    role: {
      key: roleKeys.superAdmin,
      isProtected: true,
      permissions: [],
    },
  }
  assert.throws(
    () => assertCanAssignPermissions(auth, ['future.feature.not_in_catalog']),
    (error) => error instanceof AppError && error.message === errors.rolePermissionsInvalid,
  )
})

test('Manager without leads.bulk cannot be granted that key by a non-holder', () => {
  const auth = {
    role: {
      key: roleKeys.agent,
      isProtected: false,
      permissions: [permissionKeys.leadsView, permissionKeys.leadsEdit],
    },
  }
  assert.equal(hasPermission(auth, permissionKeys.leadsBulk), false)
  assert.throws(
    () => assertCanAssignPermissions(auth, [permissionKeys.leadsView, permissionKeys.leadsBulk]),
    (error) => error instanceof AppError && error.message === errors.privilegeEscalation,
  )
})

test('Admin who holds Bulk Access can assign it', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [
        permissionKeys.rolesEdit,
        permissionKeys.leadsBulk,
        permissionKeys.leadsView,
      ],
    },
  }
  assert.doesNotThrow(() => {
    assertCanAssignPermissions(auth, [permissionKeys.leadsView, permissionKeys.leadsBulk])
  })
})

test('legacy enum aliases on a role payload are known and grantable by Super Admin', () => {
  const { isKnownPermission } = require('../src/config/permissions')
  assert.equal(isKnownPermission(permissionKeys.usersManage), true)
  assert.equal(isKnownPermission(permissionKeys.activitiesManage), true)
  assert.equal(isKnownPermission(permissionKeys.leadsBulkAssign), true)
  assert.equal(isKnownPermission('not.a.real.permission'), false)

  const auth = {
    role: {
      key: roleKeys.superAdmin,
      isProtected: true,
      permissions: [],
    },
  }
  assert.doesNotThrow(() => {
    assertCanAssignPermissions(auth, [
      permissionKeys.leadsView,
      permissionKeys.leadsBulk,
      permissionKeys.leadsBulkAssign,
      permissionKeys.leadsBulkDelete,
      permissionKeys.leadsBulkTransfer,
      permissionKeys.usersManage,
      permissionKeys.activitiesManage,
    ])
  })
})
