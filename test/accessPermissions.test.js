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
  assert.doesNotThrow(() => {
    assertCanAssignPermissions(auth, [permissionKeys.leadsBulk, permissionKeys.leadsBulkAssign])
  })
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
