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
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const graphClient = require('../src/services/metaGraph')
const {
  processIngestion,
  processSyncJobById,
  startPageLeadSync,
} = require('../src/services/metaLeadService')
const { acceptWebhookPayload } = require('../src/services/metaWebhookService')
const { encryptSecret } = require('../src/utils/metaSecrets')
const { metaWebhookIngestionStatuses } = require('../src/utils/enums')

async function registerVerifiedAdmin(prefix = 'Count') {
  clearMemoryOutbox()
  const email = `count.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName: `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    adminName: 'Count Admin',
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
    form_id: overrides.form_id || 'form-c1',
    campaign_id: 'camp-c',
    adset_id: 'adset-c',
    ad_id: 'ad-c',
    field_data: [
      { name: 'full_name', values: [overrides.name || 'Count Lead'] },
      { name: 'phone_number', values: [overrides.phone || '+971503333444'] },
      { name: 'email', values: [overrides.email || 'count@example.com'] },
    ],
  }
}

async function seedConnectedPage(admin, pageId = 'page-count-1') {
  const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
  const profile = await MetaAppProfile.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    mode: 'customer',
    label: `Count ${pageId}`,
    appId: 'app-count',
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
    metaUserId: `mu-${pageId}-${Date.now()}`,
    displayName: 'Count User',
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

/** Creates a real Lead so ingestion.leadId satisfies the FK. */
async function seedCrmLead(admin, metaLeadId) {
  const { CatalogItem } = getModels()
  const { createLead } = require('../src/services/leadService')
  const { Role, User, Company } = getModels()
  const role = await Role.findOne({
    where: { companyId: admin.companyId, isProtected: true },
  })
  const user = await User.findByPk(admin.userId)
  const company = await Company.findByPk(admin.companyId)
  const status = await CatalogItem.findOne({
    where: { companyId: admin.companyId, kind: 'status', key: 'new', isActive: true },
  })
  const result = await createLead({
    userId: admin.userId,
    companyId: admin.companyId,
    roleId: role.id,
    user,
    role,
    company,
  }, {
    name: 'Seed Lead',
    phone: `+97150${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
    email: '',
    source: 'facebook',
    statusId: status.id,
    metaLeadId,
  })
  return result.lead
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

test('lead-counts requires auth and meta.view; tenant isolation', async () => {
  const a = await registerVerifiedAdmin('CountPermA')
  const b = await registerVerifiedAdmin('CountPermB')
  const { page } = await seedConnectedPage(a, 'page-iso')

  const { MetaWebhookIngestion } = getModels()
  const lead = await seedCrmLead(a, 'lead-iso-1')
  await MetaWebhookIngestion.create({
    id: crypto.randomUUID(),
    companyId: a.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId: 'lead-iso-1',
    formId: 'f1',
    dedupeKey: `${a.companyId}:${page.pageId}:lead-iso-1`,
    status: metaWebhookIngestionStatuses.imported,
    leadId: lead.id,
  })

  const unauth = await request(app).get('/api/meta/lead-counts')
  assert.equal(unauth.status, 401)

  const forA = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${a.token}`)
  assert.equal(forA.status, 200)
  assert.equal(forA.body.data.imported, 1)
  assert.equal(forA.body.data.pages['page-iso'].imported, 1)

  const forB = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${b.token}`)
  assert.equal(forB.status, 200)
  assert.equal(forB.body.data.imported, 0)
  assert.equal(forB.body.data.pages['page-iso'] || null, null)
})

test('imported and skipped aggregates are page-scoped; pending/failed excluded from success pair', async () => {
  const admin = await registerVerifiedAdmin('CountAgg')
  const pageA = await seedConnectedPage(admin, 'page-a')
  const pageB = await seedConnectedPage(admin, 'page-b')
  const { MetaWebhookIngestion } = getModels()
  const leadA = await seedCrmLead(admin, 'imp-1')
  const leadB = await seedCrmLead(admin, 'imp-b')

  await MetaWebhookIngestion.bulkCreate([
    {
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      metaPageId: pageA.page.id,
      connectionId: pageA.page.connectionId,
      pageId: 'page-a',
      leadgenId: 'imp-1',
      formId: 'f',
      dedupeKey: `${admin.companyId}:page-a:imp-1`,
      status: metaWebhookIngestionStatuses.imported,
      leadId: leadA.id,
    },
    {
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      metaPageId: pageA.page.id,
      connectionId: pageA.page.connectionId,
      pageId: 'page-a',
      leadgenId: 'skip-1',
      formId: 'f',
      dedupeKey: `${admin.companyId}:page-a:skip-1`,
      status: metaWebhookIngestionStatuses.skipped,
    },
    {
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      metaPageId: pageA.page.id,
      connectionId: pageA.page.connectionId,
      pageId: 'page-a',
      leadgenId: 'pend-1',
      formId: 'f',
      dedupeKey: `${admin.companyId}:page-a:pend-1`,
      status: metaWebhookIngestionStatuses.pending,
    },
    {
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      metaPageId: pageA.page.id,
      connectionId: pageA.page.connectionId,
      pageId: 'page-a',
      leadgenId: 'fail-1',
      formId: 'f',
      dedupeKey: `${admin.companyId}:page-a:fail-1`,
      status: metaWebhookIngestionStatuses.failed,
    },
    {
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      metaPageId: pageB.page.id,
      connectionId: pageB.page.connectionId,
      pageId: 'page-b',
      leadgenId: 'imp-b',
      formId: 'f',
      dedupeKey: `${admin.companyId}:page-b:imp-b`,
      status: metaWebhookIngestionStatuses.imported,
      leadId: leadB.id,
    },
  ])

  const counts = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(counts.status, 200)
  assert.equal(counts.body.data.imported, 2)
  assert.equal(counts.body.data.skipped, 1)
  assert.equal(counts.body.data.pending >= 1, true)
  assert.equal(counts.body.data.failed >= 1, true)
  assert.equal(counts.body.data.pages['page-a'].imported, 1)
  assert.equal(counts.body.data.pages['page-a'].skipped, 1)
  assert.equal(counts.body.data.pages['page-b'].imported, 1)
  assert.equal(counts.body.data.pages['page-b'].skipped || 0, 0)

  const pages = await request(app)
    .get('/api/meta/pages')
    .set('Authorization', `Bearer ${admin.token}`)
  const listedA = pages.body.data.pages.find((row) => row.pageId === 'page-a')
  assert.equal(listedA.counts.imported, 1)
  assert.equal(listedA.counts.skipped, 1)
  assert.equal(pages.body.data.leadCounts.imported, 2)
})

test('imported without leadId is excluded from Successfully Imported', async () => {
  const admin = await registerVerifiedAdmin('CountNoLead')
  const { page } = await seedConnectedPage(admin, 'page-nolead')
  const { MetaWebhookIngestion } = getModels()
  await MetaWebhookIngestion.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId: 'ghost',
    formId: 'f',
    dedupeKey: `${admin.companyId}:${page.pageId}:ghost`,
    status: metaWebhookIngestionStatuses.imported,
    leadId: null,
  })
  const counts = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(counts.body.data.imported, 0)
  assert.equal(counts.body.data.pages[page.pageId]?.imported || 0, 0)
})

test('manual sync and webhook duplicates update counts without double-counting', async () => {
  const admin = await registerVerifiedAdmin('CountFlow')
  const { page } = await seedConnectedPage(admin, 'page-flow')

  mockGraphSequential([
    () => jsonResponse(leadPayload('lead-flow')),
    () => jsonResponse({ name: 'C' }),
    () => jsonResponse({ name: 'S' }),
    () => jsonResponse({ name: 'A' }),
    () => jsonResponse({ name: 'F' }),
    () => jsonResponse({ data: [{ id: 'form-flow', name: 'F' }] }),
    () => jsonResponse({ data: [leadPayload('lead-flow'), leadPayload('lead-flow-2', {
      name: 'Second',
      phone: '+971504444555',
    })] }),
    () => jsonResponse(leadPayload('lead-flow-2', {
      name: 'Second',
      phone: '+971504444555',
    })),
    () => jsonResponse({ name: 'C' }),
    () => jsonResponse({ name: 'S' }),
    () => jsonResponse({ name: 'A' }),
    () => jsonResponse({ name: 'F' }),
  ])

  await acceptWebhookPayload({
    object: 'page',
    entry: [{
      id: page.pageId,
      changes: [{
        field: 'leadgen',
        value: {
          page_id: page.pageId,
          leadgen_id: 'lead-flow',
          form_id: 'form-flow',
        },
      }],
    }],
  })
  // Duplicate webhook delivery (same dedupeKey — still one row).
  await acceptWebhookPayload({
    object: 'page',
    entry: [{
      id: page.pageId,
      changes: [{
        field: 'leadgen',
        value: {
          page_id: page.pageId,
          leadgen_id: 'lead-flow',
          form_id: 'form-flow',
        },
      }],
    }],
  })
  const { MetaWebhookIngestion } = getModels()
  const pending = await MetaWebhookIngestion.findOne({
    where: {
      companyId: admin.companyId,
      pageId: page.pageId,
      leadgenId: 'lead-flow',
    },
  })
  assert.ok(pending)
  assert.equal(await MetaWebhookIngestion.count({
    where: { companyId: admin.companyId, pageId: page.pageId, leadgenId: 'lead-flow' },
  }), 1)
  await processIngestion(pending)

  let counts = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(counts.body.data.pages[page.pageId].imported, 1)
  assert.equal(counts.body.data.pages[page.pageId].skipped || 0, 0)

  const job = await startPageLeadSync(
    { companyId: admin.companyId, userId: admin.userId },
    page.id,
    {},
  )
  await processSyncJobById(job.id)

  const { MetaSyncJob } = getModels()
  const finished = await MetaSyncJob.findByPk(job.id)
  assert.equal(finished.status, 'completed')
  // Job-run counter: already-imported lead-flow counted as skipped this run.
  assert.equal(finished.skipped >= 1, true)
  assert.equal(finished.imported >= 1, true)

  counts = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${admin.token}`)
  // Durable: lead-flow stays imported; lead-flow-2 imported. Re-scan does not add a skipped row.
  assert.equal(counts.body.data.pages[page.pageId].imported, 2)
  assert.equal(counts.body.data.pages[page.pageId].skipped || 0, 0)

  // Durable skipped row (final outcome after duplicate createLead) updates Duplicate Skipped.
  await MetaWebhookIngestion.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId: 'lead-skipped-final',
    formId: 'form-flow',
    dedupeKey: `${admin.companyId}:${page.pageId}:lead-skipped-final`,
    status: metaWebhookIngestionStatuses.skipped,
  })
  counts = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(counts.body.data.pages[page.pageId].imported, 2)
  assert.equal(counts.body.data.pages[page.pageId].skipped, 1)

  // Repeat Sync Now — durable imported stays 2 (no double count).
  mockGraphSequential([
    () => jsonResponse({ data: [{ id: 'form-flow', name: 'F' }] }),
    () => jsonResponse({ data: [leadPayload('lead-flow'), leadPayload('lead-flow-2', {
      name: 'Second',
      phone: '+971504444555',
    })] }),
  ])
  const again = await startPageLeadSync(
    { companyId: admin.companyId, userId: admin.userId },
    page.id,
    {},
  )
  await processSyncJobById(again.id)
  counts = await request(app)
    .get('/api/meta/lead-counts')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(counts.body.data.pages[page.pageId].imported, 2)
  assert.equal(counts.body.data.imported, 2)
  assert.equal(counts.body.data.pages[page.pageId].skipped, 1)
})
