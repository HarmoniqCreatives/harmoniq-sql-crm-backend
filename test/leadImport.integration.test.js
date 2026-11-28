'use strict'

/**
 * Lead Excel import — DB integration tests.
 *
 * SAFETY:
 * - Runs only when DB_NAME_TEST is set AND differs from DB_NAME.
 * - Refuses names that look like production/live.
 * - Never migrates or seeds automatically.
 *
 * Setup (local only):
 *   1. mysql < src/scripts/prepareTestDatabase.sql
 *   2. DB_NAME=harmoniq_creative_crm_test npm run db:migrate
 *   3. DB_NAME=harmoniq_creative_crm_test npm run db:seed:roles
 *   4. DB_NAME=harmoniq_creative_crm_test npm run db:seed:catalog
 *   5. DB_NAME_TEST=harmoniq_creative_crm_test npm test -- --test-name-pattern='lead import integration'
 */


const {
  isolatedTestDbConfigured,
  applyIsolatedTestDbEnv,
  assertIsolatedTestDbOrThrow,
} = require('./helpers/isolatedTestDb')
assertIsolatedTestDbOrThrow()
applyIsolatedTestDbEnv()

const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const ExcelJS = require('exceljs')
const request = require('supertest')

process.env.MAIL_DRIVER = process.env.MAIL_DRIVER || 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://crm.example.com'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://crm.example.com'


const RUN = isolatedTestDbConfigured()
if (RUN) {
  process.env.DB_NAME = process.env.DB_NAME_TEST
}

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { permissionKeys, leadEntryMethods, roleKeys } = require('../src/utils/enums')
const assignmentNotifications = require('../src/services/assignmentNotificationService')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function importTableReady() {
  const { sequelize } = getModels()
  try {
    await sequelize.query('SELECT entryMethod, importSessionId, receivedOn FROM leads LIMIT 1')
    await sequelize.query('SELECT authorDisplayName FROM lead_notes LIMIT 1')
    await sequelize.query('SELECT 1 FROM lead_import_sessions LIMIT 1')
    return true
  } catch (_error) {
    return false
  }
}

async function registerVerifiedAdmin(prefix = 'ImportCo') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `${prefix.toLowerCase()}.${Date.now()}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Admin User',
    email,
    phone: '+919876543210',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  assert.equal(register.status, 201)
  const token = decodeURIComponent(getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1])
  await request(app).post('/api/auth/verify-email').send({ token })
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)

  // Ensure Admin role includes leads.import for this company (seed may predate the key).
  const { Role } = getModels()
  const role = await Role.findByPk(login.body.data.user.role.id)
  const perms = new Set(role.permissions || [])
  perms.add(permissionKeys.leadsImport)
  perms.add(permissionKeys.leadsCreate)
  perms.add(permissionKeys.leadsEdit)
  perms.add(permissionKeys.leadsAssign)
  role.permissions = [...perms]
  await role.save()

  const relogin = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(relogin.status, 200)
  return {
    email,
    companyId: relogin.body.data.user.company.id,
    accessToken: relogin.body.data.accessToken,
    user: relogin.body.data.user,
  }
}

async function defaultStatusId(token) {
  const statuses = await request(app)
    .get('/api/catalog?kind=STATUS')
    .set('Authorization', `Bearer ${token}`)
  const neu = statuses.body.data.items.find((row) => row.key === 'new')
  assert.ok(neu)
  return neu.id
}

async function defaultTagId(token) {
  const tags = await request(app)
    .get('/api/catalog?kind=TAG')
    .set('Authorization', `Bearer ${token}`)
  const tag = tags.body.data.items[0]
  assert.ok(tag)
  return tag
}

async function buildWorkbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Leads')
  sheet.addRow([
    'Name',
    'Contact No',
    'Email',
    'Lead Source',
    'Status',
    'Received On',
    'Assigned Agent',
    'Tags',
    'Notes 1',
    'Notes 1 Added On',
    'Notes 1 Added By',
  ])
  for (const row of rows) {
    sheet.addRow(row)
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

let ready = false

before(async () => {
  if (!RUN) return
  const { sequelize } = getModels()
  await sequelize.authenticate()
  ready = await importTableReady()
})

test('lead import integration: skipped without isolated DB_NAME_TEST', { skip: RUN }, () => {
  assert.equal(RUN, false)
})

test('lead import integration: session create, validate, confirm, idempotent', {
  skip: !RUN,
}, async (t) => {
  if (!ready) {
    t.skip('Import migration not applied on DB_NAME_TEST — run migrate/seed on the test database first')
    return
  }

  const notifyCalls = []
  const originalNotify = assignmentNotifications.notifyLeadPrimaryAssignment
  assignmentNotifications.notifyLeadPrimaryAssignment = (payload) => {
    notifyCalls.push(payload)
  }

  try {
    const admin = await registerVerifiedAdmin('ImpA')
    const statusId = await defaultStatusId(admin.accessToken)
    const tag = await defaultTagId(admin.accessToken)
    void statusId

    const phoneShared = `+97150${String(Date.now()).slice(-7)}`
    const buffer = await buildWorkbookBuffer([
      [
        'Lead One',
        phoneShared,
        'one@import.test',
        'manual',
        'New',
        '25-11-2026 09:00:00',
        admin.user.name,
        tag.name,
        'First note',
        '24-11-2026 08:00:00',
        'Legacy Author',
      ],
      [
        'Lead Two',
        phoneShared,
        'two@import.test',
        'manual',
        'New',
        '25-11-2026 10:00:00',
        '',
        '',
        '',
        '',
        '',
      ],
    ])

    const created = await request(app)
      .post('/api/leads/import/sessions')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .attach('file', buffer, 'leads.xlsx')
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const sessionId = created.body.data.session.id
    assert.ok(sessionId)

    const mapping = created.body.data.suggestedMapping
    const validated = await request(app)
      .post(`/api/leads/import/sessions/${sessionId}/validate`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ mapping })
    assert.equal(validated.status, 200, JSON.stringify(validated.body))
    assert.ok(validated.body.data.session.validationSummary.duplicateRows >= 2)
    const dupRows = validated.body.data.rows.filter((row) => row.duplicate?.requiresDecision)
    assert.equal(dupRows.length, 2)
    assert.equal(dupRows[0].duplicate.type, 'excel_internal')

    const confirmToken = validated.body.data.session.confirmToken
    const confirm = await request(app)
      .post(`/api/leads/import/sessions/${sessionId}/confirm`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        confirmToken,
        decisions: [
          {
            excelRowNumber: dupRows[0].excelRowNumber,
            action: 'import_as_new',
            confirmImportAsNew: true,
          },
          {
            excelRowNumber: dupRows[1].excelRowNumber,
            action: 'skip',
          },
        ],
      })
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body))
    assert.equal(confirm.body.data.results.succeededCount, 1)
    assert.equal(confirm.body.data.results.skippedCount, 1)
    assert.equal(notifyCalls.length, 0, 'no per-row assignment emails during excel import')

    const leadId = confirm.body.data.results.succeeded[0].leadId
    const { Lead, LeadNote } = getModels()
    const lead = await Lead.findByPk(leadId)
    assert.equal(lead.entryMethod, leadEntryMethods.excelImport)
    assert.equal(lead.importSessionId, sessionId)
    assert.ok(lead.receivedOn)

    const notes = await LeadNote.findAll({ where: { leadId } })
    assert.equal(notes.length, 1)
    assert.equal(notes[0].text, 'First note')
    assert.equal(notes[0].authorDisplayName, 'Legacy Author')
    assert.equal(notes[0].createdBy, admin.user.id)

    const again = await request(app)
      .post(`/api/leads/import/sessions/${sessionId}/confirm`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decisions: [] })
    assert.equal(again.status, 200)
    assert.equal(again.body.data.idempotent, true)

    // Company isolation: other company cannot read session
    const other = await registerVerifiedAdmin('ImpB')
    const denied = await request(app)
      .get(`/api/leads/import/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
    assert.equal(denied.status, 404)

    // Permission: use non-protected Admin role without leads.import → expect 403.
    // Super Admin is isProtected and bypasses requirePermission; do not modify it.
    const { Role, User } = getModels()
    const adminRole = await Role.findOne({
      where: { companyId: admin.companyId, key: roleKeys.admin },
    })
    assert.ok(adminRole, 'company admin role must exist')
    assert.equal(adminRole.isProtected, false)
    const adminPerms = new Set(adminRole.permissions || [])
    adminPerms.add(permissionKeys.leadsView)
    adminPerms.add(permissionKeys.leadsCreate)
    adminPerms.add(permissionKeys.leadsEdit)
    adminPerms.add(permissionKeys.leadsAssign)
    adminPerms.delete(permissionKeys.leadsImport)
    adminRole.permissions = [...adminPerms]
    await adminRole.save()

    const userRow = await User.findByPk(admin.user.id)
    assert.ok(userRow)
    userRow.roleId = adminRole.id
    await userRow.save()

    const relogin = await request(app).post('/api/auth/login').send({
      email: admin.email,
      password: 'Password1!',
      companyId: admin.companyId,
    })
    assert.equal(relogin.status, 200)
    assert.equal(relogin.body.data.user.role.key, roleKeys.admin)
    assert.equal(relogin.body.data.user.role.isProtected, false)

    const forbidden = await request(app)
      .get(`/api/leads/import/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${relogin.body.data.accessToken}`)
    assert.equal(forbidden.status, 403)
  } finally {
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
  }
})

test('lead import integration: confirmToken required; wrong token rejected; correct token + idempotent retry', {
  skip: !RUN,
}, async (t) => {
  if (!ready) {
    t.skip('Import migration not applied on DB_NAME_TEST')
    return
  }

  const admin = await registerVerifiedAdmin('ImpTok')
  const phone = `+97156${String(Date.now()).slice(-7)}`
  const buffer = await buildWorkbookBuffer([
    ['Token Lead', phone, 'token@import.test', 'manual', 'New', '', '', '', '', '', ''],
  ])

  const created = await request(app)
    .post('/api/leads/import/sessions')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .attach('file', buffer, 'token.xlsx')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const sessionId = created.body.data.session.id

  const validated = await request(app)
    .post(`/api/leads/import/sessions/${sessionId}/validate`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ mapping: created.body.data.suggestedMapping })
  assert.equal(validated.status, 200, JSON.stringify(validated.body))
  assert.equal(validated.body.data.session.status, 'validated')
  const confirmToken = validated.body.data.session.confirmToken
  assert.ok(confirmToken && typeof confirmToken === 'string')

  const { Lead, LeadImportSession } = getModels()
  const leadsBefore = await Lead.count({ where: { companyId: admin.companyId } })

  const missingToken = await request(app)
    .post(`/api/leads/import/sessions/${sessionId}/confirm`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ decisions: [] })
  assert.equal(missingToken.status, 400)
  assert.match(String(missingToken.body?.error?.message || missingToken.body?.message || ''), /Validate the import session/i)

  const wrongToken = await request(app)
    .post(`/api/leads/import/sessions/${sessionId}/confirm`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ confirmToken: 'definitely-not-the-session-token', decisions: [] })
  assert.equal(wrongToken.status, 400)

  const sessionAfterReject = await LeadImportSession.findByPk(sessionId)
  assert.equal(sessionAfterReject.status, 'validated')
  assert.equal(sessionAfterReject.confirmToken, confirmToken)
  const leadsAfterReject = await Lead.count({ where: { companyId: admin.companyId } })
  assert.equal(leadsAfterReject, leadsBefore, 'rejected confirm must not create/update/restore leads')

  const confirm = await request(app)
    .post(`/api/leads/import/sessions/${sessionId}/confirm`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ confirmToken, decisions: [] })
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body))
  assert.equal(confirm.body.data.session.status, 'completed')
  assert.ok(confirm.body.data.results.succeededCount >= 1)

  const again = await request(app)
    .post(`/api/leads/import/sessions/${sessionId}/confirm`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ decisions: [] })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.idempotent, true)
})

test('lead import integration: update existing blank-safe + tag merge', {
  skip: !RUN,
}, async (t) => {
  if (!ready) {
    t.skip('Import migration not applied on DB_NAME_TEST')
    return
  }

  const admin = await registerVerifiedAdmin('ImpU')
  const tag = await defaultTagId(admin.accessToken)
  const statuses = await request(app)
    .get('/api/catalog?kind=STATUS')
    .set('Authorization', `Bearer ${admin.accessToken}`)
  const statusNew = statuses.body.data.items.find((row) => row.key === 'new')

  const phone = `+97155${String(Date.now()).slice(-7)}`
  const create = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      name: 'Existing Lead',
      phone,
      email: 'keep@example.com',
      statusId: statusNew.id,
      tagIds: [],
      agencyName: 'Keep Agency',
    })
  assert.equal(create.status, 201, JSON.stringify(create.body))
  const existingId = create.body.data.lead.id

  const secondTag = statuses.body.data // placeholder to keep structure
  void secondTag
  const tags = await request(app)
    .get('/api/catalog?kind=TAG')
    .set('Authorization', `Bearer ${admin.accessToken}`)
  const otherTag = tags.body.data.items.find((row) => row.id !== tag.id) || tag

  const buffer = await buildWorkbookBuffer([
    [
      'Updated Name',
      phone,
      '',
      'manual',
      'New',
      '',
      '',
      otherTag.name,
      'Appended note',
      '20-11-2026 12:00:00',
      '',
    ],
  ])

  const sessionRes = await request(app)
    .post('/api/leads/import/sessions')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .attach('file', buffer, 'update.xlsx')
  const sessionId = sessionRes.body.data.session.id
  const validated = await request(app)
    .post(`/api/leads/import/sessions/${sessionId}/validate`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ mapping: sessionRes.body.data.suggestedMapping })
  assert.equal(validated.status, 200)
  const row = validated.body.data.rows[0]
  assert.equal(row.duplicate?.requiresDecision, true)

  const confirm = await request(app)
    .post(`/api/leads/import/sessions/${sessionId}/confirm`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      confirmToken: validated.body.data.session.confirmToken,
      decisions: [{
        excelRowNumber: row.excelRowNumber,
        action: 'update_existing',
        existingLeadId: existingId,
      }],
    })
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body))

  const { Lead, LeadNote, LeadTag } = getModels()
  const lead = await Lead.findByPk(existingId)
  assert.equal(lead.name, 'Updated Name')
  assert.equal(lead.email, 'keep@example.com', 'blank excel email must not overwrite')
  assert.equal(lead.agencyName, 'Keep Agency', 'blank excel agency must not overwrite')

  const notes = await LeadNote.findAll({ where: { leadId: existingId } })
  assert.ok(notes.some((n) => n.text === 'Appended note'))

  const tagRows = await LeadTag.findAll({ where: { leadId: existingId } })
  assert.ok(tagRows.some((row) => row.tagId === otherTag.id))
})
