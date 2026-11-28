'use strict'


const {
  isolatedTestDbConfigured,
  applyIsolatedTestDbEnv,
  assertIsolatedTestDbOrThrow,
} = require('./helpers/isolatedTestDb')
assertIsolatedTestDbOrThrow()
applyIsolatedTestDbEnv()

const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = 'https://crm.example.com'
process.env.FRONTEND_URL = 'https://crm.example.com'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { roleKeys } = require('../src/utils/enums')
const { deriveIsDeleted, markRestored, markSoftDeleted } = require('../src/utils/softDelete')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'SoftDel') {
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
  return {
    email,
    companyId: login.body.data.user.company.id,
    accessToken: login.body.data.accessToken,
    user: login.body.data.user,
  }
}

async function authGet(token, url) {
  return request(app).get(url).set('Authorization', `Bearer ${token}`)
}

async function authPost(token, url, body = {}) {
  return request(app).post(url).set('Authorization', `Bearer ${token}`).send(body)
}

async function authDelete(token, url) {
  return request(app).delete(url).set('Authorization', `Bearer ${token}`)
}

async function defaultStatusId(token) {
  const statuses = await authGet(token, '/api/catalog?kind=STATUS')
  const neu = statuses.body.data.items.find((row) => row.key === 'new')
  assert.ok(neu)
  return neu.id
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('softDelete helpers derive and mark isDeleted rows', async () => {
  assert.equal(deriveIsDeleted({ deletedAt: new Date() }), true)
  assert.equal(deriveIsDeleted({ isDeleted: true }), true)
  assert.equal(deriveIsDeleted({ isDeleted: false, deletedAt: null }), false)

  const { CatalogItem } = getModels()
  const admin = await registerVerifiedAdmin('SoftHelper')
  const created = await authPost(admin.accessToken, '/api/catalog', {
    kind: 'STATUS',
    name: `Soft Helper ${Date.now()}`,
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const item = await CatalogItem.findByPk(created.body.data.item.id)
  await markSoftDeleted(item, { userId: admin.user.id })
  // defaultScope hides soft-deleted rows — reload unscoped
  const deleted = await CatalogItem.unscoped().findByPk(item.id)
  assert.equal(deleted.isDeleted, true)
  assert.ok(deleted.deletedAt)
  await markRestored(deleted)
  const restored = await CatalogItem.findByPk(item.id)
  assert.equal(restored.isDeleted, false)
  assert.equal(restored.deletedAt, null)
})

test('lead soft-delete + recycle bin restore; list excludes deleted', async () => {
  const admin = await registerVerifiedAdmin('SoftLead')
  const statusId = await defaultStatusId(admin.accessToken)
  const created = await authPost(admin.accessToken, '/api/leads', {
    name: 'Soft Lead',
    phone: `+9198${String(Date.now()).slice(-8)}`,
    statusId,
  })
  assert.equal(created.status, 201)
  const leadId = created.body.data.lead.id
  assert.equal(created.body.data.lead.is_deleted, false)

  const removed = await authDelete(admin.accessToken, `/api/leads/${leadId}`)
  assert.equal(removed.status, 200)

  const list = await authGet(admin.accessToken, '/api/leads')
  assert.equal(list.status, 200)
  assert.equal((list.body.data.leads || []).some((row) => row.id === leadId), false)

  const bin = await authGet(admin.accessToken, '/api/recycle-bin?entity=leads')
  assert.equal(bin.status, 200)
  assert.ok((bin.body.data.leads || []).some((row) => row.id === leadId && row.is_deleted))

  const restored = await authPost(admin.accessToken, `/api/recycle-bin/leads/${leadId}/restore`)
  assert.equal(restored.status, 200)
  assert.equal(restored.body.data.lead.is_deleted, false)

  const again = await authGet(admin.accessToken, `/api/leads/${leadId}`)
  assert.equal(again.status, 200)
})

test('custom role soft-delete + restore; system roles protected', async () => {
  const admin = await registerVerifiedAdmin('SoftRole')
  const created = await authPost(admin.accessToken, '/api/roles', {
    name: `Custom Soft ${Date.now()}`,
    description: 'soft delete role',
    permissions: ['leads.view'],
  })
  assert.equal(created.status, 201)
  const roleId = created.body.data.role.id

  const { Role } = getModels()
  const system = await Role.findOne({
    where: { companyId: admin.companyId, key: roleKeys.admin },
  })
  const blockSystem = await authDelete(admin.accessToken, `/api/roles/${system.id}`)
  assert.equal(blockSystem.status, 403)

  const deleted = await authDelete(admin.accessToken, `/api/roles/${roleId}`)
  assert.equal(deleted.status, 200)

  const listed = await authGet(admin.accessToken, '/api/roles')
  assert.equal((listed.body.data.roles || []).some((row) => row.id === roleId), false)

  const bin = await authGet(admin.accessToken, '/api/recycle-bin?entity=roles')
  assert.ok((bin.body.data.roles || []).some((row) => row.id === roleId))

  const restored = await authPost(admin.accessToken, `/api/recycle-bin/roles/${roleId}/restore`)
  assert.equal(restored.status, 200)
})

test('catalog soft-delete + restore; system catalog locked', async () => {
  const admin = await registerVerifiedAdmin('SoftCat')
  const created = await authPost(admin.accessToken, '/api/catalog', {
    kind: 'STATUS',
    name: `Soft Status ${Date.now()}`,
  })
  assert.equal(created.status, 201)
  const itemId = created.body.data.item.id

  const deleted = await authDelete(admin.accessToken, `/api/catalog/${itemId}`)
  assert.equal(deleted.status, 200)

  const list = await authGet(admin.accessToken, '/api/catalog?kind=STATUS&includeInactive=true')
  assert.equal((list.body.data.items || []).some((row) => row.id === itemId), false)

  const bin = await authGet(admin.accessToken, '/api/recycle-bin?entity=catalog')
  assert.ok((bin.body.data.items || []).some((row) => row.id === itemId))

  const restored = await authPost(admin.accessToken, `/api/recycle-bin/catalog/${itemId}/restore`)
  assert.equal(restored.status, 200)
})

test('email report soft-delete + recycle restore', async () => {
  const admin = await registerVerifiedAdmin('SoftMail')
  const created = await authPost(admin.accessToken, '/api/company/email-reports', {
    reportType: 'lead_report',
    recipients: ['ops@example.com'],
    sendHour: 9,
    sendMinute: 0,
    sendMeridiem: 'AM',
    frequency: 'daily',
  })
  assert.equal(created.status, 201)
  const reportId = created.body.data.report.id

  const deleted = await authDelete(admin.accessToken, `/api/company/email-reports/${reportId}`)
  assert.equal(deleted.status, 200)
  assert.equal(
    (deleted.body.data.emailReports.reports || []).some((row) => row.id === reportId),
    false,
  )

  const bin = await authGet(admin.accessToken, '/api/recycle-bin?entity=email_reports')
  assert.equal(bin.status, 200)
  assert.ok((bin.body.data.reports || []).some((row) => row.id === reportId))

  const restored = await authPost(
    admin.accessToken,
    `/api/recycle-bin/email_reports/${reportId}/restore`,
  )
  assert.equal(restored.status, 200)
})

test('manager without recycle_bin permissions cannot access recycle bin', async () => {
  const admin = await registerVerifiedAdmin('SoftMgr')
  const { User, Role } = getModels()
  const managerRole = await Role.findOne({
    where: { companyId: admin.companyId, key: roleKeys.manager },
  })
  assert.ok(managerRole)
  assert.equal((managerRole.permissions || []).includes('recycle_bin.view'), false)

  const { hashPassword } = require('../src/utils/helpers')
  const manager = await User.create({
    id: uuidv4(),
    companyId: admin.companyId,
    roleId: managerRole.id,
    name: 'Manager Soft',
    email: `mgr.soft.${Date.now()}@example.com`,
    passwordHash: await hashPassword('Password1!'),
    status: 'ACTIVE',
    emailVerified: true,
  })
  const login = await request(app).post('/api/auth/login').send({
    email: manager.email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)
  const token = login.body.data.accessToken

  const bin = await authGet(token, '/api/recycle-bin?entity=leads')
  assert.equal(bin.status, 403)

  const restore = await authPost(token, `/api/recycle-bin/leads/${uuidv4()}/restore`)
  assert.equal(restore.status, 403)
})
