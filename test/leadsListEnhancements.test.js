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
const { permissionKeys, roleKeys, userStatuses } = require('../src/utils/enums')
const { hashPassword } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'LeadEnh') {
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
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password1!' })
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

async function createActiveUser({ companyId, roleKey, name }) {
  const { User, Role } = getModels()
  const role = await Role.findOne({ where: { companyId, key: roleKey } })
  assert.ok(role)
  const user = await User.create({
    id: uuidv4(),
    companyId,
    roleId: role.id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@example.com`,
    phone: '+971501234567',
    passwordHash: await hashPassword('Password1!'),
    status: userStatuses.active,
    emailVerified: true,
  })
  const login = await request(app).post('/api/auth/login').send({
    email: user.email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)
  return { user, accessToken: login.body.data.accessToken, role }
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('create persists metaCreatedAt and campaignStatus; list presents them', async () => {
  const admin = await registerVerifiedAdmin('MetaFields')
  const statusId = await defaultStatusId(admin.accessToken)
  const metaCreatedAt = '2024-06-15T08:30:00.000Z'
  const created = await authPost(admin.accessToken, '/api/leads', {
    name: 'Meta Person',
    phone: '+971509999001',
    statusId,
    source: 'facebook',
    metaLeadId: `meta-enh-${Date.now()}`,
    campaignId: 'camp-1',
    campaignName: 'Summer Ads',
    campaignStatus: 'PAUSED',
    metaCreatedAt,
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const lead = created.body.data.lead
  assert.equal(lead.campaignStatus, 'PAUSED')
  assert.ok(lead.metaCreatedAt)
  assert.equal(new Date(lead.metaCreatedAt).toISOString(), metaCreatedAt)

  const listed = await authGet(admin.accessToken, '/api/leads?limit=50')
  assert.equal(listed.status, 200)
  const row = listed.body.data.leads.find((item) => item.id === lead.id)
  assert.ok(row)
  assert.equal(row.campaignStatus, 'PAUSED')
  assert.ok(row.metaCreatedAt)
})

test('date range filters Meta leads by metaCreatedAt and manual by createdAt', async () => {
  const admin = await registerVerifiedAdmin('DateRange')
  const statusId = await defaultStatusId(admin.accessToken)

  const meta = await authPost(admin.accessToken, '/api/leads', {
    name: 'Meta Range',
    phone: '+971509999002',
    statusId,
    source: 'facebook',
    metaLeadId: `meta-range-${Date.now()}`,
    campaignName: 'Camp',
    campaignStatus: 'ACTIVE',
    metaCreatedAt: '2024-03-10T12:00:00.000Z',
  })
  assert.equal(meta.status, 201)

  const manual = await authPost(admin.accessToken, '/api/leads', {
    name: 'Manual Range',
    phone: '+971509999003',
    statusId,
    source: 'manual',
  })
  assert.equal(manual.status, 201)

  const hitMeta = await authGet(admin.accessToken, '/api/leads?startDate=2024-03-10&endDate=2024-03-10')
  assert.equal(hitMeta.status, 200)
  const metaIds = hitMeta.body.data.leads.map((row) => row.id)
  assert.equal(metaIds.includes(meta.body.data.lead.id), true)
  assert.equal(metaIds.includes(manual.body.data.lead.id), false)

  const missMeta = await authGet(admin.accessToken, '/api/leads?startDate=2024-01-01&endDate=2024-01-31')
  assert.equal(missMeta.status, 200)
  assert.equal(missMeta.body.data.leads.some((row) => row.id === meta.body.data.lead.id), false)

  const badRange = await authGet(admin.accessToken, '/api/leads?startDate=2024-05-01&endDate=2024-04-01')
  assert.equal(badRange.status, 400)
})

test('xlsx export includes campaign status and meta generated date columns', async () => {
  const admin = await registerVerifiedAdmin('ExportEnh')
  const statusId = await defaultStatusId(admin.accessToken)
  const created = await authPost(admin.accessToken, '/api/leads', {
    name: 'Export Meta',
    phone: '+971509999004',
    statusId,
    source: 'facebook',
    metaLeadId: `meta-export-${Date.now()}`,
    campaignName: 'Export Camp',
    campaignStatus: 'ACTIVE',
    metaCreatedAt: '2024-07-01T09:00:00.000Z',
  })
  assert.equal(created.status, 201)

  const exported = await request(app)
    .get('/api/leads/export')
    .query({ format: 'xlsx', startDate: '2024-07-01', endDate: '2024-07-01' })
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })
  assert.equal(exported.status, 200)
  assert.match(exported.headers['content-type'], /spreadsheetml/)
  assert.ok(exported.body.length > 100)
  // XLSX is zip/PK
  assert.equal(exported.body[0], 0x50)
  assert.equal(exported.body[1], 0x4b)
})

test('bulk assign/transfer/delete enforce permissions and soft-delete', async () => {
  const admin = await registerVerifiedAdmin('BulkOps')
  const statusId = await defaultStatusId(admin.accessToken)
  const agent = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Bulk Agent',
  })
  const other = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Other Agent',
  })

  const a = await authPost(admin.accessToken, '/api/leads', {
    name: 'Bulk A', phone: '+971509999011', statusId, source: 'manual',
  })
  const b = await authPost(admin.accessToken, '/api/leads', {
    name: 'Bulk B', phone: '+971509999012', statusId, source: 'manual',
  })
  assert.equal(a.status, 201)
  assert.equal(b.status, 201)
  const ids = [a.body.data.lead.id, b.body.data.lead.id]

  // Agent without bulk_assign → 403
  const denied = await authPost(agent.accessToken, '/api/leads/bulk/assign', {
    ids,
    primaryAgentId: agent.user.id,
  })
  assert.equal(denied.status, 403)

  // Admin has bulk_assign via seed
  const assigned = await authPost(admin.accessToken, '/api/leads/bulk/assign', {
    ids: [ids[0]],
    primaryAgentId: agent.user.id,
  })
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body))
  assert.equal(assigned.body.data.succeededCount, 1)

  const transferred = await authPost(admin.accessToken, '/api/leads/bulk/transfer', {
    ids: [ids[0]],
    primaryAgentId: other.user.id,
    reason: 'Coverage',
  })
  assert.equal(transferred.status, 200, JSON.stringify(transferred.body))
  assert.equal(transferred.body.data.succeededCount, 1)

  const deleted = await authPost(admin.accessToken, '/api/leads/bulk/delete', { ids })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  assert.equal(deleted.body.data.succeededCount, 2)

  const listed = await authGet(admin.accessToken, '/api/leads')
  assert.equal(listed.body.data.leads.some((row) => ids.includes(row.id)), false)

  // Permissions present on admin role for new companies
  const perms = admin.user.role.permissions
  assert.equal(perms.includes(permissionKeys.leadsBulkAssign), true)
  assert.equal(perms.includes(permissionKeys.leadsBulkTransfer), true)
  assert.equal(perms.includes(permissionKeys.leadsBulkDelete), true)
  assert.equal(perms.includes(permissionKeys.leadsBulk), true)
})

test('admin role seed includes bulk_* and export stays leads.bulk', async () => {
  const { roleSeeds } = require('../src/config/seed')
  const admin = roleSeeds.find((row) => row.key === roleKeys.admin)
  assert.ok(admin)
  assert.equal(admin.permissions.includes(permissionKeys.leadsBulk), true)
  assert.equal(admin.permissions.includes(permissionKeys.leadsBulkAssign), true)
  assert.equal(admin.permissions.includes(permissionKeys.leadsBulkTransfer), true)
  assert.equal(admin.permissions.includes(permissionKeys.leadsBulkDelete), true)
  const manager = roleSeeds.find((row) => row.key === roleKeys.manager)
  assert.equal(manager.permissions.includes(permissionKeys.leadsBulkAssign), false)
})

test('Facebook Page filter and list/export use facebookPageName', async () => {
  const admin = await registerVerifiedAdmin('PageFilter')
  const statusId = await defaultStatusId(admin.accessToken)

  const withPage = await authPost(admin.accessToken, '/api/leads', {
    name: 'Page Lead',
    phone: '+971509999101',
    statusId,
    source: 'facebook',
    metaLeadId: `page-filter-${Date.now()}`,
    facebookPageId: 'page-123',
    facebookPageName: 'Acme FB Page',
    campaignName: 'Camp A',
    campaignStatus: 'ACTIVE',
    metaCreatedAt: '2024-08-01T10:00:00.000Z',
  })
  assert.equal(withPage.status, 201, JSON.stringify(withPage.body))

  const manual = await authPost(admin.accessToken, '/api/leads', {
    name: 'No Page Lead',
    phone: '+971509999102',
    statusId,
    source: 'manual',
  })
  assert.equal(manual.status, 201)

  const types = await authGet(admin.accessToken, '/api/leads/page-types')
  assert.equal(types.status, 200)
  assert.equal(types.body.data.pageTypes.includes('Acme FB Page'), true)

  const filtered = await authGet(admin.accessToken, '/api/leads?pageType=Acme%20FB%20Page')
  assert.equal(filtered.status, 200)
  const ids = filtered.body.data.leads.map((row) => row.id)
  assert.equal(ids.includes(withPage.body.data.lead.id), true)
  assert.equal(ids.includes(manual.body.data.lead.id), false)

  const row = filtered.body.data.leads.find((item) => item.id === withPage.body.data.lead.id)
  assert.equal(row.facebookPageName, 'Acme FB Page')
  assert.equal(row.facebookPageId, 'page-123')

  const blank = await authGet(
    admin.accessToken,
    `/api/leads?pageType=${encodeURIComponent('Unknown_Page_Type')}`,
  )
  assert.equal(blank.status, 200)
  assert.equal(blank.body.data.leads.some((item) => item.id === manual.body.data.lead.id), true)
  assert.equal(blank.body.data.leads.some((item) => item.id === withPage.body.data.lead.id), false)
})
