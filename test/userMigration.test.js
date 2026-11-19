'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const bcrypt = require('bcrypt')

const {
  createIdMap,
  mapRolePermissions,
  listSqlPermissionKeys,
  mapCompanyActivation,
  mapUserStatus,
  mapEmailVerified,
  mapRoleScope,
  isBcryptHashFormat,
  runPasswordCompatibilityTest,
  assertPasswordGate,
  validateExportPayload,
  transformExportToSqlRecords,
  reconcileAgainstDestination,
  exportFromDocuments,
  exportFromMongoLive,
  prepareImportPlan,
  importToSqlLive,
  runDryRun,
} = require('../src/migration')
const { createIsolatedImportModels } = require('../src/migration/lib/memoryStore')

const FIXTURE_PATH = path.join(__dirname, '../src/migration/fixtures/sampleExport.json')
const SAMPLE_PASSWORD = 'MigrationTest!1'
const SAMPLE_HASH = '$2b$04$ZCj5Jdky6w/9VBEFaQ93JOD.R2mBKA3oeytrN69.Z0Q68wkBYx.Ru'

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
}

describe('userMigration', () => {
  it('maps permissions with expansions and super admin full set', () => {
    const admin = mapRolePermissions(['users.manage', 'roles.manage', 'meta.manage', 'leads.view'], {
      key: 'admin',
      isProtected: false,
    })
    assert.ok(admin.permissions.includes('users.invite'))
    assert.ok(admin.permissions.includes('roles.create'))
    assert.ok(admin.permissions.includes('permissions.manage'))
    assert.ok(admin.permissions.includes('meta.view'))
    assert.ok(admin.permissions.includes('leads.view'))
    assert.equal(admin.omitted.length, 0)

    const agent = mapRolePermissions(['leads.view', 'leads.edit', 'activities.manage', 'legacy.unknown'], {
      key: 'agent',
    })
    assert.deepEqual(agent.omitted, ['legacy.unknown'])
    assert.ok(agent.permissions.includes('activities.manage'))
    assert.ok(!agent.permissions.includes('users.create'))

    const sa = mapRolePermissions(['users.manage'], { key: 'super_admin', isProtected: true })
    assert.equal(sa.permissions.length, listSqlPermissionKeys().length)
  })

  it('maps statuses per approved BD decisions', () => {
    assert.deepEqual(mapCompanyActivation({ isActiveHint: true }).status, 'ACTIVE')
    assert.deepEqual(mapCompanyActivation({ isActiveHint: false }).status, 'PENDING_VERIFICATION')
    assert.equal(mapUserStatus('active'), 'ACTIVE')
    assert.equal(mapUserStatus('disabled'), 'DISABLED')
    assert.equal(mapUserStatus('invited'), 'PENDING')
    assert.equal(mapEmailVerified(false, 'ACTIVE'), false)
    assert.equal(mapEmailVerified(undefined, 'ACTIVE'), true)
    assert.equal(mapEmailVerified(null, 'DISABLED'), false)
    assert.equal(mapRoleScope('company'), 'COMPANY')
    assert.equal(mapRoleScope('own'), 'OWN')
  })

  it('validates fixture export and flags password gate warning', () => {
    const fixture = loadFixture()
    const result = validateExportPayload(fixture)
    assert.equal(result.ok, true)
    assert.equal(result.counts.companies, 2)
    assert.equal(result.counts.roles, 4)
    assert.equal(result.counts.users, 4)
    assert.ok(result.warnings.some((w) => w.code === 'password_gate_not_passed'))
    assert.ok(result.warnings.some((w) => w.code === 'email_verified_coerced_true'))
    assert.ok(result.warnings.some((w) => w.code === 'active_user_unverified'))
  })

  it('reports initial super admin conflicts without silent resolution', () => {
    const fixture = loadFixture()
    fixture.users.push({
      _id: 'user99999999999999999999',
      companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      roleId: 'role11111111111111111111',
      name: 'Second Owner',
      email: 'owner2@falcon.example',
      passwordHash: SAMPLE_HASH,
      status: 'active',
      emailVerified: true,
      isInitialSuperAdmin: true,
      isPlatformOperator: false,
    })
    const result = validateExportPayload(fixture)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.code === 'initial_super_admin_conflict'))
  })

  it('detects cross-company role assignment', () => {
    const fixture = loadFixture()
    fixture.users[0].roleId = 'role44444444444444444444'
    const result = validateExportPayload(fixture)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.code === 'user_cross_company_role'))
  })

  it('transforms companies/roles/users and maps branch/team relationships', () => {
    const fixture = loadFixture()
    fixture.passwordGate = { passed: true, testedAt: new Date().toISOString() }
    const idMap = createIdMap()
    const records = transformExportToSqlRecords(fixture, idMap)
    assert.equal(records.branches.length, 1)
    assert.equal(records.teams.length, 1)

    const owner = records.users.find((u) => u.email === 'owner@falcon.example')
    assert.equal(owner.status, 'ACTIVE')
    assert.equal(owner.emailVerified, true)
    assert.equal(owner.branchId, null)

    const admin = records.users.find((u) => u.email === 'admin@falcon.example')
    assert.equal(admin.emailVerified, true)

    const disabled = records.users.find((u) => u.email === 'agent@falcon.example')
    assert.equal(disabled.status, 'DISABLED')
    assert.ok(disabled.branchId)
    assert.ok(disabled.teamId)
    assert.equal(disabled.branchId, records.branches[0].id)
    assert.equal(disabled.teamId, records.teams[0].id)

    const team = records.teams[0]
    assert.equal(team.branchId, records.branches[0].id)
    assert.equal(team.managerUserId, admin.id)

    const pendingOwner = records.users.find((u) => u.email === 'owner@pending.example')
    assert.equal(pendingOwner.emailVerified, false)

    const pendingCompany = records.companies.find((c) => c.mongoId === 'bbbbbbbbbbbbbbbbbbbbbbbb')
    assert.equal(pendingCompany.status, 'PENDING_VERIFICATION')
    assert.equal(pendingCompany.isActive, false)

    const saRole = records.roles.find((r) => r.key === 'super_admin' && r.companyMongoId === 'aaaaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(saRole.permissions.length, listSqlPermissionKeys().length)

    const adminRole = records.roles.find((r) => r.key === 'admin')
    assert.ok(adminRole.permissions.includes('users.invite'))
    assert.ok(adminRole.permissions.includes('meta.view'))

    const again = transformExportToSqlRecords(fixture, idMap)
    assert.equal(again.users[0].id, records.users[0].id)
  })

  it('rejects cross-company branch/team assignments', () => {
    const fixture = loadFixture()
    fixture.users[0].branchId = 'branch111111111111111111'
    fixture.users[0].companyId = 'bbbbbbbbbbbbbbbbbbbbbbbb'
    fixture.users[0].roleId = 'role44444444444444444444'
    const result = validateExportPayload(fixture)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.code === 'user_cross_company_branch'))
  })

  it('reconciles destination matches without mutating data', () => {
    const fixture = loadFixture()
    fixture.passwordGate = { passed: true }
    const plan = prepareImportPlan(fixture)
    assert.equal(plan.ok, true)
    assert.equal(plan.reconciliation.readyToImport.users, 4)

    const snapshot = {
      companies: [{ id: plan.records.companies[0].id, nameKey: plan.records.companies[0].nameKey }],
      roles: [],
      branches: [],
      teams: [],
      users: [{ id: plan.records.users[0].id, companyId: plan.records.users[0].companyId, email: plan.records.users[0].email }],
    }
    const recon = reconcileAgainstDestination(plan.records, snapshot)
    assert.equal(recon.existingMatches.companies, 1)
    assert.equal(recon.existingMatches.users, 1)
    assert.equal(recon.readyToImport.users, 3)
    assert.equal(recon.conflicts.length, 0)
  })

  it('imports into an isolated in-memory store without touching MySQL', async () => {
    const fixture = loadFixture()
    fixture.passwordGate = { passed: true, testedAt: new Date().toISOString() }
    const models = createIsolatedImportModels()
    const previousLive = process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT
    const previousApproved = process.env.MIGRATION_IMPORT_APPROVED
    process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT = '1'
    process.env.MIGRATION_IMPORT_APPROVED = '1'
    try {
      const emptyDest = {
        companies: [],
        roles: [],
        branches: [],
        teams: [],
        users: [],
      }
      const result = await importToSqlLive(fixture, {
        allowLiveImport: true,
        models,
        sequelize: models.sequelize,
        destinationSnapshot: emptyDest,
      })
      assert.equal(result.ok, true)
      assert.equal(result.inserted.companies, 2)
      assert.equal(result.inserted.branches, 1)
      assert.equal(result.inserted.teams, 1)
      assert.equal(result.inserted.roles, 4)
      assert.equal(result.inserted.users, 4)

      const afterFirst = {
        companies: (await models.Company.findAll()).map((r) => ({ id: r.id, nameKey: r.nameKey })),
        roles: (await models.Role.findAll()).map((r) => ({ id: r.id, companyId: r.companyId, key: r.key })),
        branches: (await models.Branch.findAll()).map((r) => ({
          id: r.id,
          companyId: r.companyId,
          nameKey: r.nameKey,
        })),
        teams: (await models.Team.findAll()).map((r) => ({
          id: r.id,
          companyId: r.companyId,
          branchId: r.branchId,
          nameKey: r.nameKey,
        })),
        users: (await models.User.findAll()).map((r) => ({
          id: r.id,
          companyId: r.companyId,
          email: r.email,
        })),
      }
      const again = await importToSqlLive(fixture, {
        allowLiveImport: true,
        models,
        sequelize: models.sequelize,
        destinationSnapshot: afterFirst,
      })
      assert.equal(again.inserted.users, 0)
      assert.equal(again.existing.users, 4)

      const agent = (await models.User.findAll()).find((u) => u.email === 'agent@falcon.example')
      assert.ok(agent.branchId)
      assert.ok(agent.teamId)
      assert.ok(agent.passwordHash.startsWith('$2'))
      const team = await models.Team.findByPk(agent.teamId)
      assert.ok(team.managerUserId)
    } finally {
      if (previousLive == null) delete process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT
      else process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT = previousLive
      if (previousApproved == null) delete process.env.MIGRATION_IMPORT_APPROVED
      else process.env.MIGRATION_IMPORT_APPROVED = previousApproved
    }
  })

  it('password gate blocks live import helpers', async () => {
    assert.equal(isBcryptHashFormat(SAMPLE_HASH), true)
    const probe = await runPasswordCompatibilityTest({
      password: SAMPLE_PASSWORD,
      passwordHash: SAMPLE_HASH,
    })
    assert.equal(probe.ok, true)

    assert.throws(() => assertPasswordGate({ passed: false }), (err) => err.code === 'PASSWORD_COMPATIBILITY_GATE_BLOCKED')

    const fixture = loadFixture()
    await assert.rejects(
      () => importToSqlLive(fixture, { allowLiveImport: true }),
      (err) => err.code === 'LIVE_SQL_IMPORT_ENV_BLOCKED' || err.code === 'PASSWORD_COMPATIBILITY_GATE_BLOCKED' || err.code === 'LIVE_SQL_IMPORT_APPROVAL_REQUIRED',
    )
  })

  it('blocks live mongo export without flags', async () => {
    await assert.rejects(
      () => exportFromMongoLive({ allowLiveExport: false }),
      (err) => err.code === 'LIVE_MONGO_EXPORT_BLOCKED',
    )
  })

  it('exportFromDocuments and dry-run produce redacted report', () => {
    const fixture = loadFixture()
    const exported = exportFromDocuments(fixture)
    assert.equal(exported.counts.users, 4)
    assert.ok(exported.users[0].passwordHash)

    const dry = runDryRun(fixture)
    assert.equal(dry.validation.ok, true)
    assert.ok(dry.reportMarkdown.includes('passwordHash') === false || dry.reportMarkdown.includes('[REDACTED]') || !dry.reportMarkdown.includes(SAMPLE_HASH))
    assert.ok(!dry.reportMarkdown.includes(SAMPLE_HASH))
    assert.ok(dry.transformPreview.sampleUser.passwordHash === '[REDACTED]')
  })

  it('prepareImportPlan redacts secrets in preview', () => {
    const fixture = loadFixture()
    fixture.passwordGate = { passed: true }
    const plan = prepareImportPlan(fixture)
    assert.equal(plan.ok, true)
    assert.equal(plan.safePreview.users[0].passwordHash, '[REDACTED]')
    assert.ok(plan.records.users[0].passwordHash.startsWith('$2'))
  })

  it('bcrypt can verify fixture hash (SQL bcrypt package)', async () => {
    const matched = await bcrypt.compare(SAMPLE_PASSWORD, SAMPLE_HASH)
    assert.equal(matched, true)
  })
})
