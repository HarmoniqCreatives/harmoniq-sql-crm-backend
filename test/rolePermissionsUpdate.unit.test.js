'use strict'

/**
 * DB-free unit tests for role permission update / legacy preservation (PR #6 parity).
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { resolveUpdatedPermissions } = require('../src/services/roleService')
const { assertCanAssignPermissions } = require('../src/services/accessService')
const { isKnownPermission } = require('../src/config/permissions')
const { AppError, errors } = require('../src/utils/errors')
const { permissionKeys, roleKeys } = require('../src/utils/enums')
const { requireAnyPermission } = require('../src/middleware/auth')

const legacyBundle = [
  permissionKeys.activitiesManage,
  permissionKeys.templatesManage,
  permissionKeys.communicationsSend,
  permissionKeys.auditView,
  permissionKeys.usersManage,
  permissionKeys.rolesManage,
]

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

test('legacy aliases are known to isKnownPermission', () => {
  for (const key of legacyBundle) {
    assert.equal(isKnownPermission(key), true, key)
  }
  assert.equal(isKnownPermission('totally.unknown.permission'), false)
})

test('existing role retains legacy permissions when matrix keys are edited', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [
        permissionKeys.rolesEdit,
        permissionKeys.leadsView,
        permissionKeys.leadsEdit,
      ],
    },
  }
  const existing = [
    permissionKeys.leadsView,
    ...legacyBundle,
  ]
  const submitted = [
    permissionKeys.leadsView,
    permissionKeys.leadsEdit,
    ...legacyBundle,
  ]
  const next = resolveUpdatedPermissions(auth, existing, submitted)
  for (const key of legacyBundle) {
    assert.equal(next.includes(key), true, `must retain ${key}`)
  }
  assert.equal(next.includes(permissionKeys.leadsEdit), true)
})

test('hidden legacy permissions remain when omitted from submittedPermissions', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [
        permissionKeys.rolesEdit,
        permissionKeys.leadsView,
        permissionKeys.leadsEdit,
      ],
    },
  }
  const existing = [
    permissionKeys.leadsView,
    permissionKeys.activitiesManage,
    permissionKeys.usersManage,
    permissionKeys.rolesManage,
  ]
  // Frontend matrix omit: only visible keys submitted.
  const next = resolveUpdatedPermissions(auth, existing, [
    permissionKeys.leadsView,
    permissionKeys.leadsEdit,
  ])
  assert.equal(next.includes(permissionKeys.leadsEdit), true)
  assert.equal(next.includes(permissionKeys.activitiesManage), true)
  assert.equal(next.includes(permissionKeys.usersManage), true)
  assert.equal(next.includes(permissionKeys.rolesManage), true)
})

test('legacy permissions not previously assigned are not automatically added', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [
        permissionKeys.rolesEdit,
        permissionKeys.leadsView,
        permissionKeys.leadsEdit,
      ],
    },
  }
  const existing = [permissionKeys.leadsView, permissionKeys.activitiesManage]
  const next = resolveUpdatedPermissions(auth, existing, [
    permissionKeys.leadsView,
    permissionKeys.leadsEdit,
  ])
  assert.equal(next.includes(permissionKeys.activitiesManage), true)
  assert.equal(next.includes(permissionKeys.templatesManage), false)
  assert.equal(next.includes(permissionKeys.communicationsSend), false)
  assert.equal(next.includes(permissionKeys.auditView), false)
  assert.equal(next.includes(permissionKeys.usersManage), false)
  assert.equal(next.includes(permissionKeys.rolesManage), false)
})

test('authorized user can add a matrix permission without losing hidden legacy keys', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [
        permissionKeys.rolesEdit,
        permissionKeys.leadsView,
        permissionKeys.leadsBulk,
      ],
    },
  }
  const existing = [permissionKeys.leadsView, permissionKeys.activitiesManage]
  const next = resolveUpdatedPermissions(auth, existing, [
    permissionKeys.leadsView,
    permissionKeys.leadsBulk,
  ])
  assert.equal(next.includes(permissionKeys.leadsBulk), true)
  assert.equal(next.includes(permissionKeys.activitiesManage), true)
})

test('newly added unauthorized permissions are still rejected', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [permissionKeys.rolesEdit, permissionKeys.leadsView],
    },
  }
  assert.throws(
    () => resolveUpdatedPermissions(
      auth,
      [permissionKeys.leadsView, permissionKeys.activitiesManage],
      [permissionKeys.leadsView, permissionKeys.leadsBulk],
    ),
    (error) => error instanceof AppError && error.message === errors.privilegeEscalation,
  )
})

test('existing legacy permission may remain even when actor does not hold it', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [permissionKeys.rolesEdit, permissionKeys.leadsView],
    },
  }
  assert.equal(auth.role.permissions.includes(permissionKeys.activitiesManage), false)
  const next = resolveUpdatedPermissions(
    auth,
    [permissionKeys.leadsView, permissionKeys.activitiesManage],
    [permissionKeys.leadsView],
  )
  assert.equal(next.includes(permissionKeys.activitiesManage), true)
})

test('unknown permissions are rejected on update', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [permissionKeys.rolesEdit, permissionKeys.leadsView],
    },
  }
  assert.throws(
    () => resolveUpdatedPermissions(
      auth,
      [permissionKeys.leadsView],
      [permissionKeys.leadsView, 'not.a.real.permission'],
    ),
    (error) => error instanceof AppError && error.message === errors.rolePermissionsInvalid,
  )
})

test('roles.manage authorizes PATCH via requireAnyPermission with roles.edit', async () => {
  assert.equal(permissionKeys.rolesManage, 'roles.manage')
  assert.equal(isKnownPermission(permissionKeys.rolesManage), true)

  const patchGate = requireAnyPermission([
    permissionKeys.rolesEdit,
    permissionKeys.rolesManage,
  ])

  await assert.doesNotReject(() => invoke(patchGate, {
    auth: {
      role: {
        key: roleKeys.admin,
        isProtected: false,
        permissions: [permissionKeys.rolesManage],
      },
    },
  }))

  await assert.doesNotReject(() => invoke(patchGate, {
    auth: {
      role: {
        key: roleKeys.admin,
        isProtected: false,
        permissions: [permissionKeys.rolesEdit],
      },
    },
  }))

  await assert.rejects(
    () => invoke(patchGate, {
      auth: {
        role: {
          key: roleKeys.admin,
          isProtected: false,
          permissions: [permissionKeys.rolesView],
        },
      },
    }),
    (error) => error instanceof AppError
      && error.statusCode === 403
      && error.message === errors.forbidden,
  )

  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/modules/roles/roleRoutes.js'),
    'utf8',
  )
  assert.match(
    src,
    /requireAnyPermission\(\[\s*permissionKeys\.rolesEdit,\s*permissionKeys\.rolesManage\s*\]\)/,
  )
})

test('createRole still enforces full grant policy (not newly-added-only)', () => {
  const auth = {
    role: {
      key: roleKeys.admin,
      isProtected: false,
      permissions: [permissionKeys.rolesCreate, permissionKeys.leadsView],
    },
  }
  // Full create policy: every submitted key must be held (legacy not exempt).
  assert.throws(
    () => assertCanAssignPermissions(auth, [
      permissionKeys.leadsView,
      permissionKeys.activitiesManage,
    ]),
    (error) => error instanceof AppError && error.message === errors.privilegeEscalation,
  )

  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/services/roleService.js'),
    'utf8',
  )
  const createFn = src.slice(
    src.indexOf('async function createRole'),
    src.indexOf('async function updateRole'),
  )
  assert.match(createFn, /assertCanAssignPermissions\(auth, permissions\)/)
  assert.ok(
    !createFn.includes('newlyAdded'),
    'create must not use newly-added-only escalation checks',
  )
  assert.ok(
    !createFn.includes('resolveUpdatedPermissions'),
    'create must not use update-only legacy preservation helper',
  )
})
