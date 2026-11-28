'use strict'

/**
 * Unit tests for centralized Super Admin permission bypass in auth middleware.
 * No database — exercises requirePermission / requireAnyPermission only.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { requireAnyPermission, requirePermission } = require('../src/middleware/auth')
const { AppError, errors } = require('../src/utils/errors')
const { permissionKeys, roleKeys } = require('../src/utils/enums')
const { hasPermission } = require('../src/services/accessService')

const FUTURE_KEY = 'future.module.never_seeded_in_catalog'

function invoke(middleware, req) {
  return new Promise((resolve, reject) => {
    Promise.resolve(middleware(req, {}, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })).catch(reject)
  })
}

test('Super Admin hasPermission allows keys absent from the permission catalog', () => {
  const auth = {
    role: {
      key: roleKeys.superAdmin,
      isProtected: true,
      permissions: [],
    },
  }
  assert.equal(hasPermission(auth, FUTURE_KEY), true)
  assert.equal(hasPermission(auth, permissionKeys.leadsImport), true)
})

test('requirePermission: Super Admin with empty permissions array passes future keys', async () => {
  const req = {
    auth: {
      role: {
        key: roleKeys.superAdmin,
        isProtected: true,
        permissions: [],
      },
    },
  }
  await assert.doesNotReject(() => invoke(requirePermission(FUTURE_KEY), req))
  await assert.doesNotReject(() => invoke(requirePermission(permissionKeys.leadsImport), req))
})

test('requirePermission: Super Admin identified by role key alone (isProtected false) still bypasses', async () => {
  const req = {
    auth: {
      role: {
        key: roleKeys.superAdmin,
        isProtected: false,
        permissions: [],
      },
    },
  }
  await assert.doesNotReject(() => invoke(requirePermission(FUTURE_KEY), req))
})

test('requirePermission: Admin without permission receives 403', async () => {
  const req = {
    auth: {
      role: {
        key: roleKeys.admin,
        isProtected: false,
        permissions: [permissionKeys.leadsView],
      },
    },
  }
  await assert.rejects(
    () => invoke(requirePermission(permissionKeys.leadsImport), req),
    (error) => error instanceof AppError
      && error.statusCode === 403
      && error.message === errors.forbidden,
  )
})

test('requirePermission: Admin with permission is allowed', async () => {
  const req = {
    auth: {
      role: {
        key: roleKeys.admin,
        isProtected: false,
        permissions: [permissionKeys.leadsImport, permissionKeys.leadsView],
      },
    },
  }
  await assert.doesNotReject(() => invoke(requirePermission(permissionKeys.leadsImport), req))
})

test('requirePermission: missing auth is 401', async () => {
  await assert.rejects(
    () => invoke(requirePermission(permissionKeys.leadsView), {}),
    (error) => error instanceof AppError && error.statusCode === 401,
  )
})

test('requireAnyPermission uses the same Super Admin bypass', async () => {
  const superReq = {
    auth: {
      role: { key: roleKeys.superAdmin, isProtected: true, permissions: [] },
    },
  }
  await assert.doesNotReject(() => invoke(
    requireAnyPermission([FUTURE_KEY, permissionKeys.leadsView]),
    superReq,
  ))

  const adminReq = {
    auth: {
      role: {
        key: roleKeys.admin,
        isProtected: false,
        permissions: [permissionKeys.leadsView],
      },
    },
  }
  await assert.doesNotReject(() => invoke(
    requireAnyPermission([permissionKeys.leadsImport, permissionKeys.leadsView]),
    adminReq,
  ))
  await assert.rejects(
    () => invoke(requireAnyPermission([permissionKeys.leadsImport]), adminReq),
    (error) => error instanceof AppError && error.statusCode === 403,
  )
})

test('non-Super Admin never receives automatic all-access', () => {
  const manager = {
    role: {
      key: roleKeys.manager,
      isProtected: false,
      permissions: [permissionKeys.leadsView],
    },
  }
  assert.equal(hasPermission(manager, FUTURE_KEY), false)
  assert.equal(hasPermission(manager, permissionKeys.leadsImport), false)
  assert.equal(hasPermission(manager, permissionKeys.leadsView), true)
})
