const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { after, before, beforeEach, test } = require('node:test')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.META_SYNC_AUTORUN = '0'
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token'
process.env.META_APP_SECRET = 'test-app-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_REDIRECT_URI = 'http://localhost:5001/api/meta/oauth/callback'
process.env.APP_BASE_URL = 'http://localhost:5174'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const graphClient = require('../src/services/metaGraph')
const {
  enqueueInitialPageSync,
  processSyncJobById,
} = require('../src/services/metaLeadService')
const { encryptSecret } = require('../src/utils/metaSecrets')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'Init') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `init.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Init Admin',
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
    form_id: overrides.form_id || 'form-init-1',
    campaign_id: 'camp-init',
    adset_id: 'adset-init',
    ad_id: 'ad-init',
    field_data: [
      { name: 'full_name', values: [overrides.name || 'Init Lead'] },
      { name: 'phone_number', values: [overrides.phone || '+971501111222'] },
      { name: 'email', values: [overrides.email || 'init@example.com'] },
    ],
  }
}

async function seedConnection(admin) {
  const { MetaAppProfile, MetaConnection } = getModels()
  const profile = await MetaAppProfile.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    mode: 'customer',
    label: 'Init App',
    appId: 'app-init',
    appSecretCipher: encryptSecret('secret'),
    secretStored: true,
    isActive: true,
    createdBy: admin.userId,
    updatedBy: admin.userId,
  })
  const connection = await MetaConnection.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    appProfileId: profile.id,
    metaUserId: `mu-init-${Date.now()}`,
    displayName: 'Init User',
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
  return { profile, connection }
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
})

test('page connect enqueues initial sync job and imports leads across forms', async () => {
  const admin = await registerVerifiedAdmin('InitImport')
  const { connection } = await seedConnection(admin)

  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-init', name: 'Init Page', access_token: 'page-token-init' }],
    }),
    () => jsonResponse({ success: true }),
  ])

  const connected = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-init'] })
  assert.equal(connected.status, 200)
  assert.equal(connected.body.data.results[0].status, 'added')
  assert.equal(connected.body.data.results[0].initialSyncStarted, true)
  const jobId = connected.body.data.results[0].syncJob.id
  const metaPageId = connected.body.data.results[0].page.id
  assert.ok(jobId)

  mockGraphSequential([
    () => jsonResponse({
      data: [
        { id: 'form-init-1', name: 'Form One' },
        { id: 'form-init-2', name: 'Form Two' },
      ],
    }),
    () => jsonResponse({ data: [leadPayload('lead-init-a')] }),
    () => jsonResponse(leadPayload('lead-init-a')),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form One' }),
    () => jsonResponse({
      data: [leadPayload('lead-init-b', {
        name: 'Second Init',
        phone: '+971502222333',
        form_id: 'form-init-2',
      })],
    }),
    () => jsonResponse(leadPayload('lead-init-b', {
      name: 'Second Init',
      phone: '+971502222333',
      form_id: 'form-init-2',
    })),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form Two' }),
  ])

  await processSyncJobById(jobId)
  const { MetaSyncJob, Lead, MetaPage } = getModels()
  const job = await MetaSyncJob.findByPk(jobId)
  assert.equal(job.status, 'completed')
  assert.equal(job.imported >= 2, true)
  const leads = await Lead.findAll({
    where: { companyId: admin.companyId, source: 'facebook' },
  })
  assert.equal(leads.length >= 2, true)
  const page = await MetaPage.findByPk(metaPageId)
  assert.ok(page.lastSyncAt)

  const list = await request(app)
    .get('/api/meta/pages')
    .set('Authorization', `Bearer ${admin.token}`)
  const listed = list.body.data.pages.find((row) => row.id === metaPageId)
  assert.equal(listed.latestSyncJob.status, 'completed')
})

test('repeated connect does not create a second sync job while page stays connected', async () => {
  const admin = await registerVerifiedAdmin('InitDup')
  const { connection } = await seedConnection(admin)

  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-dup', name: 'Dup Page', access_token: 'tok' }],
    }),
    () => jsonResponse({ success: true }),
  ])
  const first = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-dup'] })
  assert.equal(first.body.data.results[0].initialSyncStarted, true)
  const firstJobId = first.body.data.results[0].syncJob.id

  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-dup', name: 'Dup Page', access_token: 'tok' }],
    }),
  ])
  const second = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-dup'] })
  assert.equal(second.body.data.results[0].status, 'skipped')
  assert.equal(second.body.data.results[0].syncJob || null, null)

  const { MetaSyncJob } = getModels()
  const jobs = await MetaSyncJob.findAll({
    where: { companyId: admin.companyId, facebookPageId: 'page-dup' },
  })
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, firstJobId)
})

test('webhook subscription failure does not enqueue initial sync', async () => {
  const admin = await registerVerifiedAdmin('InitSubFail')
  const { connection } = await seedConnection(admin)

  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-subfail', name: 'Sub Fail', access_token: 'tok' }],
    }),
    () => jsonResponse({ error: { message: 'denied', code: 200 } }, 400),
  ])
  const result = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-subfail'] })
  assert.equal(result.body.data.results[0].status, 'failed')
  assert.ok(result.body.data.results[0].reason)
  assert.equal(result.body.data.results[0].initialSyncStarted || false, false)

  const { MetaSyncJob } = getModels()
  const jobs = await MetaSyncJob.findAll({
    where: { companyId: admin.companyId, facebookPageId: 'page-subfail' },
  })
  assert.equal(jobs.length, 0)
})

test('failed enqueue is recoverable via Sync Now without duplicate leads', async () => {
  const admin = await registerVerifiedAdmin('InitRecover')
  const { connection } = await seedConnection(admin)

  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-recover', name: 'Recover', access_token: 'tok' }],
    }),
    () => jsonResponse({ success: true }),
  ])
  const connected = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-recover'] })
  const metaPageId = connected.body.data.results[0].page.id
  const firstJobId = connected.body.data.results[0].syncJob.id

  // Simulate interrupted / failed initial job.
  const { MetaSyncJob, Lead } = getModels()
  await MetaSyncJob.update(
    { status: 'failed', errorMessage: 'interrupted', finishedAt: new Date() },
    { where: { id: firstJobId } },
  )

  mockGraphSequential([
    () => jsonResponse({ data: [{ id: 'form-r', name: 'F' }] }),
    () => jsonResponse({ data: [leadPayload('lead-recover')] }),
    () => jsonResponse(leadPayload('lead-recover')),
    () => jsonResponse({ name: 'C' }),
    () => jsonResponse({ name: 'S' }),
    () => jsonResponse({ name: 'A' }),
    () => jsonResponse({ name: 'F' }),
  ])
  const retry = await request(app)
    .post(`/api/meta/pages/${metaPageId}/sync`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({})
  assert.equal(retry.status, 202)
  assert.notEqual(retry.body.data.id, firstJobId)
  await processSyncJobById(retry.body.data.id)
  assert.equal(await Lead.count({
    where: { companyId: admin.companyId, metaLeadId: 'lead-recover' },
  }), 1)

  mockGraphSequential([
    () => jsonResponse({ data: [{ id: 'form-r', name: 'F' }] }),
    () => jsonResponse({ data: [leadPayload('lead-recover')] }),
  ])
  const again = await request(app)
    .post(`/api/meta/pages/${metaPageId}/sync`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({})
  await processSyncJobById(again.body.data.id)
  assert.equal(await Lead.count({
    where: { companyId: admin.companyId, metaLeadId: 'lead-recover' },
  }), 1)
})

test('enqueueInitialPageSync returns error without throwing for unknown page', async () => {
  const admin = await registerVerifiedAdmin('InitEnqueue')
  const result = await enqueueInitialPageSync(
    { companyId: admin.companyId, userId: admin.userId },
    crypto.randomUUID(),
  )
  assert.equal(result.syncJob, null)
  assert.ok(result.syncEnqueueError)
})

test('cross-company cannot see another company initial sync job', async () => {
  const a = await registerVerifiedAdmin('InitTenantA')
  const b = await registerVerifiedAdmin('InitTenantB')
  const { connection } = await seedConnection(a)

  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-tenant', name: 'Tenant', access_token: 'tok' }],
    }),
    () => jsonResponse({ success: true }),
  ])
  const connected = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${a.token}`)
    .send({ pageIds: ['page-tenant'] })
  const metaPageId = connected.body.data.results[0].page.id
  const jobId = connected.body.data.results[0].syncJob.id

  const cross = await request(app)
    .get(`/api/meta/pages/${metaPageId}/sync-jobs/${jobId}`)
    .set('Authorization', `Bearer ${b.token}`)
  assert.equal(cross.status, 404)
})
