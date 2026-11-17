const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { after, before, beforeEach, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.META_SYNC_AUTORUN = '0'
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token'
process.env.META_APP_SECRET = 'test-app-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_REDIRECT_URI = 'http://localhost:5001/api/meta/oauth/callback'
process.env.APP_BASE_URL = 'http://localhost:5174'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('hex')
process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const assignmentNotifications = require('../src/services/assignmentNotificationService')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const {
  processIngestion,
  processSyncJobById,
  startPageLeadSync,
} = require('../src/services/metaLeadService')
const {
  resolveMetaDefaultPrimaryAgentId,
} = require('../src/services/metaAssigneeService')
const graphClient = require('../src/services/metaGraph')
const { encryptSecret } = require('../src/utils/metaSecrets')
const {
  metaWebhookIngestionStatuses,
  permissionKeys,
  roleKeys,
  userStatuses,
} = require('../src/utils/enums')
const { hashPassword } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'Assignee') {
  clearMemoryOutbox()
  assignmentNotifications.clearNotificationDedupe()
  const companyName = uniqueName(prefix)
  const email = `assignee.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Assignee Admin',
    email,
    phone: '+919876543210',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  const link = getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)
  await request(app).post('/api/auth/verify-email').send({
    token: decodeURIComponent(link[1]),
  })
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  return {
    token: login.body.data.accessToken,
    companyId: login.body.data.user.company.id,
    userId: login.body.data.user.id,
  }
}

async function createActiveAgent(companyId, name) {
  const { User, Role } = getModels()
  const role = await Role.findOne({ where: { companyId, key: roleKeys.agent } })
  assert.ok(role)
  return User.create({
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
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function mockGraphSequential(handlers) {
  let i = 0
  graphClient.setFetchImpl(async (input) => {
    const url = String(input)
    const handler = handlers[i]
    i += 1
    if (!handler) throw new Error(`Unexpected Graph call: ${url}`)
    return handler(url)
  })
}

function leadPayload(id, overrides = {}) {
  return {
    id,
    created_time: '2024-01-15T10:00:00+0000',
    form_id: overrides.form_id || 'form-assignee',
    campaign_id: 'camp-assignee',
    adset_id: 'adset-assignee',
    ad_id: 'ad-assignee',
    field_data: [
      { name: 'full_name', values: [overrides.name || 'Assignee Lead'] },
      { name: 'phone_number', values: [overrides.phone || '+971501222333'] },
      { name: 'email', values: [overrides.email || 'assignee-lead@example.com'] },
    ],
  }
}

async function seedConnectedPage(admin, pageId) {
  const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
  const profile = await MetaAppProfile.create({
    id: uuidv4(),
    companyId: admin.companyId,
    mode: 'customer',
    label: `Assignee ${pageId}`,
    appId: 'app-assignee',
    appSecretCipher: encryptSecret('secret'),
    secretStored: true,
    isActive: true,
    createdBy: admin.userId,
    updatedBy: admin.userId,
  })
  const connection = await MetaConnection.create({
    id: uuidv4(),
    companyId: admin.companyId,
    appProfileId: profile.id,
    metaUserId: `mu-${pageId}`,
    displayName: 'Assignee FB',
    status: 'connected',
    grantedPermissions: [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_metadata',
      'leads_retrieval',
      'ads_read',
    ],
    declinedPermissions: [],
    missingPermissions: [],
    pageFetchErrors: [],
    connectedBy: admin.userId,
    tokenCipher: encryptSecret('user-token'),
  })
  const page = await MetaPage.create({
    id: uuidv4(),
    companyId: admin.companyId,
    connectionId: connection.id,
    appProfileId: profile.id,
    pageId,
    name: `Page ${pageId}`,
    status: 'connected',
    tokenCipher: encryptSecret('page-token'),
    webhookSubscribed: true,
  })
  return { profile, connection, page }
}

async function seedPendingIngestion(admin, page, leadgenId) {
  const { MetaWebhookIngestion } = getModels()
  return MetaWebhookIngestion.create({
    id: uuidv4(),
    companyId: admin.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId,
    formId: 'form-assignee',
    dedupeKey: `${admin.companyId}:${page.pageId}:${leadgenId}`,
    status: metaWebhookIngestionStatuses.pending,
    nextAttemptAt: new Date(Date.now() - 1000),
  })
}

function stubNotify(notifyCalls) {
  const original = assignmentNotifications.notifyLeadPrimaryAssignment
  assignmentNotifications.notifyLeadPrimaryAssignment = (details) => {
    const queued = original(details)
    if (queued.queued) notifyCalls.push(details)
    return queued
  }
  return original
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

after(() => {
  graphClient.resetFetchImpl()
})

beforeEach(() => {
  graphClient.resetFetchImpl()
  assignmentNotifications.clearNotificationDedupe()
})

test('GET/PATCH default-assignee: auth, set, clear, and tenant isolation', async () => {
  const a = await registerVerifiedAdmin('AssigneeApiA')
  const b = await registerVerifiedAdmin('AssigneeApiB')
  const agentA = await createActiveAgent(a.companyId, 'Agent Alpha')
  const agentB = await createActiveAgent(b.companyId, 'Agent Beta')

  const unauth = await request(app).get('/api/meta/default-assignee')
  assert.equal(unauth.status, 401)

  const listA = await request(app)
    .get('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${a.token}`)
  assert.equal(listA.status, 200)
  assert.equal(listA.body.data.assignee, null)
  assert.ok(listA.body.data.agents.some((row) => row.id === agentA.id))
  assert.equal(listA.body.data.agents.some((row) => row.id === agentB.id), false)

  const cross = await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ userId: agentB.id })
  assert.equal(cross.status, 404)

  const setOk = await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ userId: agentA.id })
  assert.equal(setOk.status, 200)
  assert.equal(setOk.body.data.assignee.id, agentA.id)

  const getOk = await request(app)
    .get('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${a.token}`)
  assert.equal(getOk.body.data.assignee.id, agentA.id)

  const clear = await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ userId: null })
  assert.equal(clear.status, 200)
  assert.equal(clear.body.data.assignee, null)

  const { Role, User } = getModels()
  const user = await User.findByPk(a.userId)
  const role = await Role.findByPk(user.roleId)
  role.permissions = (role.permissions || []).filter((key) => key !== permissionKeys.metaManage)
  await role.save()
  const forbidden = await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ userId: agentA.id })
  assert.equal(forbidden.status, 403)
})

test('PATCH rejects inactive same-company user', async () => {
  const admin = await registerVerifiedAdmin('AssigneeInactive')
  const agent = await createActiveAgent(admin.companyId, 'Soon Inactive')
  agent.status = userStatuses.disabled
  await agent.save()

  const response = await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ userId: agent.id })
  assert.equal(response.status, 404)
})

test('Meta import assigns default primary agent and queues one new_lead email', async () => {
  const admin = await registerVerifiedAdmin('AssigneeImport')
  const agent = await createActiveAgent(admin.companyId, 'Import Agent')
  await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ userId: agent.id })

  const { page } = await seedConnectedPage(admin, `page-import-${Date.now()}`)
  const leadgenId = `lead-assigned-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)

  const notifyCalls = []
  const originalNotify = stubNotify(notifyCalls)
  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, { phone: '+971501222334' })),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])

  try {
    const result = await processIngestion(ingestion)
    assert.equal(result.status, metaWebhookIngestionStatuses.imported)
    const { Lead } = getModels()
    const lead = await Lead.findByPk(result.leadId)
    assert.equal(lead.primaryAgentId, agent.id)
    assert.equal(notifyCalls.length, 1)
    assert.equal(notifyCalls[0].emailKind, assignmentNotifications.EMAIL_KINDS.newLead)
    assert.equal(String(notifyCalls[0].newPrimaryAgentId), String(agent.id))
    assert.equal(notifyCalls[0].assignedByName, assignmentNotifications.META_ASSIGNED_BY)
    assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: leadgenId } }), 1)

    // Shared createLead path rejects duplicate metaLeadId without a second notify
    const { Role, User, Company, CatalogItem } = getModels()
    const { createLead } = require('../src/services/leadService')
    const actorUser = await User.findByPk(admin.userId)
    const role = await Role.findByPk(actorUser.roleId)
    const company = await Company.findByPk(admin.companyId)
    const status = await CatalogItem.findOne({
      where: { companyId: admin.companyId, kind: 'STATUS', key: 'new', isActive: true },
    })
    await assert.rejects(
      () => createLead({
        userId: admin.userId,
        companyId: admin.companyId,
        roleId: role.id,
        user: actorUser,
        role,
        company,
      }, {
        name: 'Dup Meta',
        phone: '+971501222399',
        source: 'facebook',
        statusId: status.id,
        metaLeadId: leadgenId,
        primaryAgentId: agent.id,
      }),
      (error) => error.statusCode === 409,
    )
    assert.equal(notifyCalls.length, 1)
    assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: leadgenId } }), 1)
  } finally {
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
  }
})

test('Meta import without default assignee remains unassigned and sends no email', async () => {
  const admin = await registerVerifiedAdmin('AssigneeNone')
  const { page } = await seedConnectedPage(admin, `page-none-${Date.now()}`)
  const leadgenId = `lead-none-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)
  const notifyCalls = []
  const originalNotify = stubNotify(notifyCalls)
  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, { phone: '+971501222335' })),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])
  try {
    const result = await processIngestion(ingestion)
    assert.equal(result.status, metaWebhookIngestionStatuses.imported)
    const { Lead } = getModels()
    const lead = await Lead.findByPk(result.leadId)
    assert.equal(lead.primaryAgentId, null)
    assert.equal(notifyCalls.length, 0)
  } finally {
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
  }
})

test('inactive configured assignee imports unassigned safely', async () => {
  const admin = await registerVerifiedAdmin('AssigneeStale')
  const agent = await createActiveAgent(admin.companyId, 'Stale Agent')
  const { Company } = getModels()
  const company = await Company.findByPk(admin.companyId)
  company.metaDefaultAssigneeUserId = agent.id
  await company.save()
  agent.status = userStatuses.disabled
  await agent.save()

  assert.equal(await resolveMetaDefaultPrimaryAgentId(admin.companyId), null)

  const { page } = await seedConnectedPage(admin, `page-stale-${Date.now()}`)
  const leadgenId = `lead-stale-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)
  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, { phone: '+971501222336' })),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])
  const result = await processIngestion(ingestion)
  assert.equal(result.status, metaWebhookIngestionStatuses.imported)
  const { Lead } = getModels()
  const lead = await Lead.findByPk(result.leadId)
  assert.equal(lead.primaryAgentId, null)
})

test('manual sync path also applies default assignee', async () => {
  const admin = await registerVerifiedAdmin('AssigneeSync')
  const agent = await createActiveAgent(admin.companyId, 'Sync Agent')
  await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ userId: agent.id })

  const { page } = await seedConnectedPage(admin, `page-sync-assignee-${Date.now()}`)
  const leadgenId = `lead-sync-${Date.now()}`
  mockGraphSequential([
    () => jsonResponse({ data: [{ id: 'form-assignee', name: 'Form' }] }),
    () => jsonResponse({ data: [leadPayload(leadgenId, { phone: '+971501222337' })] }),
    () => jsonResponse(leadPayload(leadgenId, { phone: '+971501222337' })),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])

  const started = await startPageLeadSync(
    {
      userId: admin.userId,
      companyId: admin.companyId,
      role: { permissions: [permissionKeys.metaPagesManage] },
      user: { id: admin.userId },
    },
    page.id,
    {},
  )
  await processSyncJobById(started.id)

  const { Lead } = getModels()
  const lead = await Lead.findOne({
    where: { companyId: admin.companyId, metaLeadId: leadgenId },
  })
  assert.ok(lead)
  assert.equal(lead.primaryAgentId, agent.id)
})

test('notify throw during Meta create does not fail import', async () => {
  const admin = await registerVerifiedAdmin('AssigneeSoft')
  const agent = await createActiveAgent(admin.companyId, 'Soft Agent')
  await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ userId: agent.id })

  const { page } = await seedConnectedPage(admin, `page-soft-${Date.now()}`)
  const leadgenId = `lead-soft-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)
  const originalNotify = assignmentNotifications.notifyLeadPrimaryAssignment
  assignmentNotifications.notifyLeadPrimaryAssignment = () => {
    throw new Error('notify boom')
  }
  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, { phone: '+971501222338' })),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])
  try {
    const result = await processIngestion(ingestion)
    assert.equal(result.status, metaWebhookIngestionStatuses.imported)
    const { Lead } = getModels()
    const lead = await Lead.findByPk(result.leadId)
    assert.equal(lead.primaryAgentId, agent.id)
  } finally {
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
  }
})
