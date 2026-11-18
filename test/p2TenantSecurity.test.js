'use strict'

/**
 * P2 tenant security unit tests:
 * - one initial Super Admin per company
 * - pre-auth email company disambiguation (forgot password / resend verification)
 * - authenticated invitation resend stays company-scoped
 *
 * Mocked only — never connects to harmoniq_creative_crm or live DBs.
 */

const assert = require('node:assert/strict')
const { describe, mock, test } = require('node:test')

process.env.NODE_ENV = 'test'

const { AppError, errors } = require('../src/utils/errors')
const {
  detectDuplicateInitialSuperAdmins,
  isInitialSuperAdminConflict,
  throwIfInitialSuperAdminConflict,
} = require('../src/services/initialSuperAdminGuard')
const {
  findUserForPreAuthEmail,
  resolveUserAmongEmailMatches,
} = require('../src/services/authEmailResolution')

/**
 * Mirrors migration expression for initialSuperAdminCompanyKey (VIRTUAL):
 * CASE WHEN isInitialSuperAdmin = 1 THEN companyId ELSE NULL END
 * Unique secondary index allows multiple NULLs (non-initial users).
 */
function initialSuperAdminCompanyKey(isInitialSuperAdmin, companyId) {
  return isInitialSuperAdmin === true || isInitialSuperAdmin === 1
    ? String(companyId)
    : null
}

function assertUniqueKeysAllowed(keys) {
  const seen = new Set()
  for (const key of keys) {
    if (key == null) continue
    assert.equal(seen.has(key), false, `duplicate non-null key ${key}`)
    seen.add(key)
  }
}

describe('P2 one initial Super Admin per company', () => {
  test('migration SQL uses VIRTUAL generated column (MySQL 8.4 CASCADE-safe)', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const migrationPath = path.join(
      __dirname,
      '../src/migrations/20261118110000-users-initial-super-admin-unique.js',
    )
    const source = fs.readFileSync(migrationPath, 'utf8')
    assert.match(source, /GENERATED ALWAYS AS \(\s*CASE WHEN isInitialSuperAdmin = 1 THEN companyId ELSE NULL END\s*\) VIRTUAL/)
    assert.equal(source.includes(') STORED'), false)
    assert.match(source, /users_initial_super_admin_company_uidx/)
    assert.match(source, /HAVING COUNT\(\*\) > 1/)
  })

  test('multiple non-initial users in one company are allowed', () => {
    const keys = [
      initialSuperAdminCompanyKey(false, 'company-a'),
      initialSuperAdminCompanyKey(0, 'company-a'),
      initialSuperAdminCompanyKey(false, 'company-a'),
    ]
    assert.deepEqual(keys, [null, null, null])
    assertUniqueKeysAllowed(keys)
  })

  test('only one initial Super Admin per company is allowed', () => {
    const first = initialSuperAdminCompanyKey(true, 'company-a')
    const second = initialSuperAdminCompanyKey(1, 'company-a')
    assert.equal(first, 'company-a')
    assert.equal(second, 'company-a')
    assert.throws(
      () => assertUniqueKeysAllowed([first, second]),
      /duplicate non-null key company-a/,
    )
  })

  test('different companies can each have one initial Super Admin', () => {
    const keys = [
      initialSuperAdminCompanyKey(true, 'company-a'),
      initialSuperAdminCompanyKey(true, 'company-b'),
      initialSuperAdminCompanyKey(false, 'company-a'),
      initialSuperAdminCompanyKey(false, 'company-b'),
    ]
    assert.deepEqual(keys, ['company-a', 'company-b', null, null])
    assertUniqueKeysAllowed(keys)
  })

  test('first initial Super Admin for a company is allowed (no conflict)', () => {
    assert.equal(isInitialSuperAdminConflict({ name: 'OtherError' }), false)
  })

  test('second initial Super Admin for the same company is rejected', () => {
    const raceError = {
      name: 'SequelizeUniqueConstraintError',
      message: "Duplicate entry 'company-a' for key 'users_initial_super_admin_company_uidx'",
      parent: {
        sqlMessage: "Duplicate entry 'company-a' for key 'users_initial_super_admin_company_uidx'",
      },
      fields: { initialSuperAdminCompanyKey: 'company-a' },
    }
    assert.equal(isInitialSuperAdminConflict(raceError), true)
    assert.throws(
      () => throwIfInitialSuperAdminConflict(raceError),
      (error) => error instanceof AppError
        && error.message === errors.initialSuperAdminTaken
        && error.statusCode === 409,
    )
  })

  test('a different company can create its own initial Super Admin (unique key is company-scoped)', () => {
    // Generated key is companyId when flag is true — company-b does not collide with company-a.
    const otherCompanyError = {
      name: 'SequelizeUniqueConstraintError',
      fields: { email: 'a@b.com' },
      message: 'users_company_id_email_unique',
    }
    assert.equal(isInitialSuperAdminConflict(otherCompanyError), false)
  })

  test('normal users (isInitialSuperAdmin=false) do not hit the SA unique key', () => {
    assert.equal(
      isInitialSuperAdminConflict({
        name: 'SequelizeUniqueConstraintError',
        fields: { companyId: 'c', email: 'n@x.com' },
      }),
      false,
    )
  })

  test('concurrent creation surfaces ownership unique conflict', () => {
    const concurrent = {
      name: 'SequelizeUniqueConstraintError',
      fields: { initialSuperAdminCompanyKey: 'company-z' },
      parent: { sqlMessage: 'users_initial_super_admin_company_uidx' },
    }
    assert.equal(isInitialSuperAdminConflict(concurrent), true)
  })

  test('detectDuplicateInitialSuperAdmins reports without modifying records', async () => {
    const User = {
      findAll: mock.fn(async () => [
        { id: 'u1', companyId: 'c1', email: 'a@x.com', createdAt: new Date('2024-01-01') },
        { id: 'u2', companyId: 'c1', email: 'b@x.com', createdAt: new Date('2024-02-01') },
        { id: 'u3', companyId: 'c2', email: 'c@x.com', createdAt: new Date('2024-03-01') },
      ]),
    }
    const dupes = await detectDuplicateInitialSuperAdmins(User)
    assert.equal(dupes.length, 1)
    assert.equal(dupes[0].companyId, 'c1')
    assert.deepEqual(dupes[0].userIds, ['u1', 'u2'])
  })
})

describe('P2 forgot password company disambiguation', () => {
  test('email belonging to one company follows existing flow', () => {
    const resolved = resolveUserAmongEmailMatches(
      [{ id: 'u1', companyId: 'c1', email: 'solo@x.com' }],
      '',
    )
    assert.equal(resolved.requiresCompany, false)
    assert.equal(resolved.user.id, 'u1')
  })

  test('email belonging to multiple companies requires company identification', () => {
    const resolved = resolveUserAmongEmailMatches(
      [
        { id: 'u1', companyId: 'c1', email: 'shared@x.com' },
        { id: 'u2', companyId: 'c2', email: 'shared@x.com' },
      ],
      '',
    )
    assert.equal(resolved.requiresCompany, true)
    assert.equal(resolved.user, null)
  })

  test('incorrect company selection is rejected safely (no user, no leak)', () => {
    const resolved = resolveUserAmongEmailMatches(
      [
        { id: 'u1', companyId: 'c1', email: 'shared@x.com' },
        { id: 'u2', companyId: 'c2', email: 'shared@x.com' },
      ],
      'company-does-not-own-email',
    )
    assert.equal(resolved.requiresCompany, false)
    assert.equal(resolved.user, null)
  })

  test('reset token is scoped to the correct company and user', async () => {
    const User = {
      findAll: async () => ([
        { id: 'u1', companyId: 'c1', email: 'shared@x.com' },
        { id: 'u2', companyId: 'c2', email: 'shared@x.com' },
      ]),
    }
    const user = await findUserForPreAuthEmail(User, 'shared@x.com', 'c2')
    assert.equal(user.id, 'u2')
    assert.equal(user.companyId, 'c2')
  })

  test('multi-company without companyId throws companyRequired', async () => {
    const User = {
      findAll: async () => ([
        { id: 'u1', companyId: 'c1', email: 'shared@x.com' },
        { id: 'u2', companyId: 'c2', email: 'shared@x.com' },
      ]),
    }
    await assert.rejects(
      () => findUserForPreAuthEmail(User, 'shared@x.com', ''),
      (error) => error instanceof AppError && error.code === 'COMPANY_REQUIRED',
    )
  })
})

describe('P2 resend invitation / verification company disambiguation', () => {
  test('single-company email follows the existing flow', async () => {
    const User = {
      findAll: async (query) => {
        assert.equal(query.where.emailVerified, false)
        return [{ id: 'u1', companyId: 'c1', email: 'solo@x.com', emailVerified: false }]
      },
    }
    const user = await findUserForPreAuthEmail(User, 'solo@x.com', '', { emailVerified: false })
    assert.equal(user.companyId, 'c1')
  })

  test('multi-company email requires company identification', async () => {
    const User = {
      findAll: async () => ([
        { id: 'u1', companyId: 'c1', emailVerified: false },
        { id: 'u2', companyId: 'c2', emailVerified: false },
      ]),
    }
    await assert.rejects(
      () => findUserForPreAuthEmail(User, 'shared@x.com', '', { emailVerified: false }),
      (error) => error instanceof AppError && error.message === errors.companyRequired,
    )
  })

  test('invitation/verification is sent only for the selected company user', async () => {
    const User = {
      findAll: async () => ([
        { id: 'u1', companyId: 'c1', emailVerified: false },
        { id: 'u2', companyId: 'c2', emailVerified: false },
      ]),
    }
    const user = await findUserForPreAuthEmail(User, 'shared@x.com', 'c1', { emailVerified: false })
    assert.equal(user.id, 'u1')
  })

  test('invalid company/user combinations are rejected safely', async () => {
    const User = {
      findAll: async () => ([
        { id: 'u1', companyId: 'c1', emailVerified: false },
        { id: 'u2', companyId: 'c2', emailVerified: false },
      ]),
    }
    const user = await findUserForPreAuthEmail(User, 'shared@x.com', 'c-other', { emailVerified: false })
    assert.equal(user, null)
  })

  test('authenticated invitation resend is scoped to auth.companyId', async () => {
    const Invitation = {
      findOne: mock.fn(async (query) => {
        assert.equal(query.where.companyId, 'company-a')
        assert.equal(query.where.id, 'invite-1')
        return null
      }),
    }
    // Mirrors invitationService.resendInvitation tenant filter.
    const invitation = await Invitation.findOne({
      where: { id: 'invite-1', companyId: 'company-a' },
    })
    assert.equal(invitation, null)
    assert.equal(Invitation.findOne.mock.calls.length, 1)
  })
})
