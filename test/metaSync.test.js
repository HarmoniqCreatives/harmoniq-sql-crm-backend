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
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const graphClient = require('../src/services/metaGraph')
const {
  processSyncJobById,
  startPageLeadSync,
} = require('../src/services/metaLeadService')
const { encryptSecret } = require('../src/utils/metaSecrets')
const { permissionKeys } = require('../src/utils/enums')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'Sync') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `sync.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Sync Admin',
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
  graphClient.setFetchImpl(async (input, init) => {
    const url = String(input)
    const handler = handlers[i]
    i += 1
    if (!handler) throw new Error(`Unexpected Graph call: ${url}`)
    return handler(url, init)
  })
}

async function seedConnectedPage(admin, pageId = 'page-sync-1') {
  const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
  const profile = await MetaAppProfile.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    mode: 'customer',
    label: `Sync ${pageId}`,
    appId: 'app-sync',
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
    metaUserId: `mu-${pageId}`,
    displayName: 'Sync User',
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
    id: crypto.randomUUID(),
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

function leadPayload(id, overrides = {}) {
  return {
    id,
    created_time: '2024-01-15T10:00:00+0000',
    form_id: overrides.form_id || 'form-1',
    campaign_id: overrides.campaign_id || 'camp-1',
    adset_id: 'adset-1',
    ad_id: 'ad-1',
    field_data: [
      { name: 'full_name', values: [overrides.name || 'Meta Lead'] },
      { name: 'phone_number', values: [overrides.phone || '+971501234567'] },
      { name: 'email', values: [overrides.email || 'lead@example.com'] },
    ],
  }
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

test('manual sync requires auth and meta.pages.manage; cross-tenant page returns 404', async () => {
  const a = await registerVerifiedAdmin('SyncPermA')
  const b = await registerVerifiedAdmin('SyncPermB')
  const { page } = await seedConnectedPage(a, 'page-perm')

  const unauth = await request(app).post(`/api/meta/pages/${page.id}/sync`)
  assert.equal(unauth.status, 401)

  const { Role, User } = getModels()
  const user = await User.findByPk(a.userId)
  const role = await Role.findByPk(user.roleId)
  role.permissions = role.permissions.filter((key) => key !== permissionKeys.metaPagesManage)
  await role.save()
  const forbidden = await request(app)
    .post(`/api/meta/pages/${page.id}/sync`)
    .set('Authorization', `Bearer ${a.token}`)
  assert.equal(forbidden.status, 403)

  const cross = await request(app)
    .post(`/api/meta/pages/${page.id}/sync`)
    .set('Authorization', `Bearer ${b.token}`)
  assert.equal(cross.status, 404)
})

test('manual sync imports leads across forms with pagination and skips duplicates', async () => {
  const admin = await registerVerifiedAdmin('SyncImport')
  const { page } = await seedConnectedPage(admin, 'page-import')

  mockGraphSequential([
    // forms page 1
    () => jsonResponse({
      data: [{ id: 'form-1', name: 'Form One' }, { id: 'form-2', name: 'Form Two' }],
    }),
    // form-1 leads page 1 + next
    () => jsonResponse({
      data: [leadPayload('lead-a')],
      paging: { next: 'https://graph.facebook.com/v21.0/form-1/leads?after=1' },
    }),
    () => jsonResponse({
      data: [leadPayload('lead-b', { name: 'Second Lead', phone: '+971509998877' })],
    }),
    // readLead lead-a + object names (campaign, adset, ad, form) x4
    () => jsonResponse(leadPayload('lead-a')),
    () => jsonResponse({ name: 'Campaign A' }),
    () => jsonResponse({ name: 'AdSet A' }),
    () => jsonResponse({ name: 'Ad A' }),
    () => jsonResponse({ name: 'Form One' }),
    // readLead lead-b + names
    () => jsonResponse(leadPayload('lead-b', { name: 'Second Lead', phone: '+971509998877' })),
    () => jsonResponse({ name: 'Campaign A' }),
    () => jsonResponse({ name: 'AdSet A' }),
    () => jsonResponse({ name: 'Ad A' }),
    () => jsonResponse({ name: 'Form One' }),
    // form-2 leads (duplicate lead-a already imported → skipped, no readLead)
    () => jsonResponse({
      data: [leadPayload('lead-a')],
    }),
  ])

  const started = await request(app)
    .post(`/api/meta/pages/${page.id}/sync`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({})
  assert.equal(started.status, 202)
  assert.ok(started.body.data.id)
  assert.equal(['pending', 'processing'].includes(started.body.data.status), true)

  const overlap = await request(app)
    .post(`/api/meta/pages/${page.id}/sync`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({})
  assert.equal(overlap.status, 202)
  assert.equal(overlap.body.data.id, started.body.data.id)

  await processSyncJobById(started.body.data.id)

  const job = await request(app)
    .get(`/api/meta/pages/${page.id}/sync-jobs/${started.body.data.id}`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(job.status, 200)
  assert.equal(job.body.data.status, 'completed')
  assert.equal(job.body.data.imported >= 2, true)
  assert.equal(job.body.data.skipped >= 1, true)
  assert.equal(JSON.stringify(job.body).includes('page-token'), false)

  const { Lead, MetaPage } = getModels()
  const leads = await Lead.findAll({ where: { companyId: admin.companyId, source: 'facebook' } })
  assert.equal(leads.length >= 2, true)
  assert.ok(leads.every((row) => row.metaLeadId))
  await page.reload()
  assert.ok(page.lastSyncAt)
})

test('expired token marks page expired and fails the job', async () => {
  const admin = await registerVerifiedAdmin('SyncExpired')
  const { page } = await seedConnectedPage(admin, 'page-expired')

  mockGraphSequential([
    () => jsonResponse({ error: { message: 'Session invalid', code: 190 } }, 400),
  ])

  const started = await startPageLeadSync(
    { companyId: admin.companyId, userId: admin.userId },
    page.id,
    {},
  )
  await processSyncJobById(started.id)

  const { MetaSyncJob, MetaPage } = getModels()
  const job = await MetaSyncJob.findByPk(started.id)
  assert.equal(job.status, 'failed')
  await page.reload()
  assert.equal(page.status, 'expired')
})

test('rate limit fails sync job without false success', async () => {
  const admin = await registerVerifiedAdmin('SyncRate')
  const { page } = await seedConnectedPage(admin, 'page-rate')

  mockGraphSequential([
    () => jsonResponse({ error: { message: 'rate', code: 17 } }, 400),
  ])

  const started = await startPageLeadSync(
    { companyId: admin.companyId, userId: admin.userId },
    page.id,
    {},
  )
  await processSyncJobById(started.id)
  const { MetaSyncJob } = getModels()
  const job = await MetaSyncJob.findByPk(started.id)
  assert.equal(job.status, 'failed')
  assert.match(job.errorMessage, /rate/i)
})

test('DB claim prevents double-processing the same pending job', async () => {
  const admin = await registerVerifiedAdmin('SyncLock')
  const { page } = await seedConnectedPage(admin, 'page-lock')

  mockGraphSequential([
    () => jsonResponse({ data: [{ id: 'form-lock', name: 'F' }] }),
    () => jsonResponse({ data: [] }),
  ])

  const started = await startPageLeadSync(
    { companyId: admin.companyId, userId: admin.userId },
    page.id,
    {},
  )
  const first = await processSyncJobById(started.id)
  const second = await processSyncJobById(started.id)
  assert.ok(first)
  assert.equal(second, null)
})

test('incomplete Meta lead is counted failed without creating a CRM lead', async () => {
  const admin = await registerVerifiedAdmin('SyncIncomplete')
  const { page } = await seedConnectedPage(admin, 'page-incomplete')

  mockGraphSequential([
    () => jsonResponse({ data: [{ id: 'form-bad', name: 'Bad' }] }),
    () => jsonResponse({
      data: [leadPayload('lead-bad', { phone: 'not-a-phone' })],
    }),
    () => jsonResponse(leadPayload('lead-bad', { phone: 'not-a-phone' })),
  ])

  const started = await startPageLeadSync(
    { companyId: admin.companyId, userId: admin.userId },
    page.id,
    {},
  )
  await processSyncJobById(started.id)
  const { MetaSyncJob, Lead } = getModels()
  const job = await MetaSyncJob.findByPk(started.id)
  assert.equal(job.status, 'completed')
  assert.equal(job.failed >= 1, true)
  const leads = await Lead.findAll({ where: { companyId: admin.companyId, metaLeadId: 'lead-bad' } })
  assert.equal(leads.length, 0)
})

test('webhook pending row and manual sync share dedupe and skip duplicate create', async () => {
  const admin = await registerVerifiedAdmin('SyncRace')
  const { page } = await seedConnectedPage(admin, 'page-race')
  const { MetaWebhookIngestion, Lead } = getModels()
  const { acceptWebhookPayload } = require('../src/services/metaWebhookService')
  const { processDueIngestions } = require('../src/services/metaLeadService')

  mockGraphSequential([
    () => jsonResponse(leadPayload('lead-race')),
    () => jsonResponse({ name: 'Campaign' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
    () => jsonResponse({ data: [{ id: 'form-race', name: 'Form' }] }),
    () => jsonResponse({ data: [leadPayload('lead-race')] }),
  ])

  await acceptWebhookPayload({
    object: 'page',
    entry: [{
      id: page.pageId,
      changes: [{
        field: 'leadgen',
        value: {
          page_id: page.pageId,
          leadgen_id: 'lead-race',
          form_id: 'form-race',
        },
      }],
    }],
  })
  await processDueIngestions()
  const afterWebhook = await Lead.count({
    where: { companyId: admin.companyId, metaLeadId: 'lead-race' },
  })
  assert.equal(afterWebhook, 1)

  const started = await startPageLeadSync(
    { companyId: admin.companyId, userId: admin.userId },
    page.id,
    {},
  )
  await processSyncJobById(started.id)
  const { MetaSyncJob } = getModels()
  const job = await MetaSyncJob.findByPk(started.id)
  assert.equal(job.status, 'completed')
  assert.equal(job.skipped >= 1, true)
  assert.equal(await Lead.count({
    where: { companyId: admin.companyId, metaLeadId: 'lead-race' },
  }), 1)
  const ingestions = await MetaWebhookIngestion.findAll({
    where: { companyId: admin.companyId, leadgenId: 'lead-race' },
  })
  assert.equal(ingestions.length, 1)
})
