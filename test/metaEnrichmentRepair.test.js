const assert = require('node:assert/strict')
const { after, before, beforeEach, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.META_SYNC_AUTORUN = '0'
process.env.META_AUTO_SYNC_ENABLED = 'false'
process.env.META_AUTO_SYNC_INTERVAL_MINUTES = '10'
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token'
process.env.META_APP_SECRET = 'test-app-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_REDIRECT_URI = 'http://localhost:5001/api/meta/oauth/callback'
process.env.APP_BASE_URL = 'http://localhost:5174'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const {
  processIngestion,
  startPageLeadSync,
  processSyncJobById,
} = require('../src/services/metaLeadService')
const {
  applyMetaMetadataToLead,
  buildFillEmptyMetadataPatch,
  leadNeedsMetaRepair,
  metaEnrichmentStatuses,
} = require('../src/services/metaEnrichmentService')
const graphClient = require('../src/services/metaGraph')
const { encryptSecret } = require('../src/utils/metaSecrets')
const {
  metaWebhookIngestionStatuses,
  permissionKeys,
  userStatuses,
} = require('../src/utils/enums')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'EnrichRepair') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `enrich.repair.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Enrich Admin',
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

function mockGraphByUrl(handlers) {
  graphClient.setFetchImpl(async (input) => {
    const url = String(input)
    for (const row of handlers) {
      if (row.match.test(url)) {
        return row.handle(url)
      }
    }
    throw new Error(`Unexpected Graph call: ${url}`)
  })
}

function leadPayload(id, overrides = {}) {
  return {
    id,
    created_time: '2024-06-01T12:00:00+0000',
    form_id: overrides.form_id || 'form-repair',
    campaign_id: overrides.campaign_id || 'camp-repair',
    adset_id: overrides.adset_id || 'adset-repair',
    ad_id: overrides.ad_id || 'ad-repair',
    field_data: [
      { name: 'full_name', values: [overrides.name || 'Repair Lead'] },
      { name: 'phone_number', values: [overrides.phone || '+971501234567'] },
      { name: 'email', values: [overrides.email || 'repair@example.com'] },
    ],
  }
}

async function seedConnectedPage(admin, pageId) {
  const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
  const profile = await MetaAppProfile.create({
    id: uuidv4(),
    companyId: admin.companyId,
    mode: 'customer',
    label: `Repair ${pageId}`,
    appId: 'app-repair',
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
    displayName: 'Repair FB',
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

test('fill-empty patch never overwrites non-empty metadata or assignment fields', () => {
  const lead = {
    campaignName: 'Keep Me',
    campaignStatus: 'ACTIVE',
    adName: '',
    primaryAgentId: 'agent-1',
    name: 'Lead',
    phone: '+1555',
    email: 'a@b.com',
  }
  const { patch, fields } = buildFillEmptyMetadataPatch(lead, {
    campaignName: 'New Name',
    campaignStatus: 'PAUSED',
    adName: 'Ad One',
    primaryAgentId: 'agent-2',
    name: 'Hacked',
  })
  assert.equal(patch.campaignName, undefined)
  assert.equal(patch.campaignStatus, undefined)
  assert.equal(patch.adName, 'Ad One')
  assert.ok(fields.includes('adName'))
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'primaryAgentId'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'name'), false)
})

test('GET /meta/auto-sync-config exposes env visibility without secrets', async () => {
  const admin = await registerVerifiedAdmin('AutoCfg')
  const response = await request(app)
    .get('/api/meta/auto-sync-config')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.data.enabled, false)
  assert.equal(response.body.data.intervalMinutes, 10)
  assert.equal(typeof response.body.data.workerAutorunEnabled, 'boolean')
  assert.ok(response.body.data.note)
})

test('import stores structured ad/form metadata and enrichment status', async () => {
  const admin = await registerVerifiedAdmin('EnrichCreate')
  const { page } = await seedConnectedPage(admin, `page-create-${Date.now()}`)
  const leadgenId = `lead-create-${Date.now()}`
  const { MetaWebhookIngestion } = getModels()
  const ingestion = await MetaWebhookIngestion.create({
    id: uuidv4(),
    companyId: admin.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId,
    formId: 'form-repair',
    dedupeKey: `${admin.companyId}:${page.pageId}:${leadgenId}`,
    status: metaWebhookIngestionStatuses.pending,
    retryCount: 0,
  })

  mockGraphByUrl([
    {
      match: new RegExp(`/${leadgenId}\\?`),
      handle: () => jsonResponse(leadPayload(leadgenId)),
    },
    {
      match: /camp-repair/,
      handle: () => jsonResponse({ name: 'Camp A', effective_status: 'ACTIVE' }),
    },
    {
      match: /ad-repair/,
      handle: () => jsonResponse({ name: 'Ad A' }),
    },
    {
      match: /adset-repair/,
      handle: () => jsonResponse({ name: 'AdSet A' }),
    },
    {
      match: /form-repair/,
      handle: () => jsonResponse({ name: 'Form A' }),
    },
  ])

  const result = await processIngestion(ingestion)
  assert.equal(result.status, metaWebhookIngestionStatuses.imported)
  const { Lead } = getModels()
  const lead = await Lead.findByPk(result.leadId)
  assert.equal(lead.campaignId, 'camp-repair')
  assert.equal(lead.campaignName, 'Camp A')
  assert.equal(lead.campaignStatus, 'ACTIVE')
  assert.equal(lead.adId, 'ad-repair')
  assert.equal(lead.adName, 'Ad A')
  assert.equal(lead.adSetId, 'adset-repair')
  assert.equal(lead.adSetName, 'AdSet A')
  assert.equal(lead.formId, 'form-repair')
  assert.equal(lead.formName, 'Form A')
  assert.equal(lead.metaEnrichmentStatus, metaEnrichmentStatuses.completed)

  const list = await request(app)
    .get('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(list.status, 200)
  const row = (list.body.data.leads || []).find((item) => item.id === lead.id)
  assert.ok(row)
  assert.equal(row.campaignId, 'camp-repair')
  assert.equal(row.adName, 'Ad A')
  assert.equal(row.formName, 'Form A')
})

test('later sync repairs empty campaign metadata without duplicate or assignment change', async () => {
  const admin = await registerVerifiedAdmin('EnrichRepairSync')
  const agentRes = await request(app)
    .patch('/api/meta/default-assignee')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ userId: admin.userId })
  assert.equal(agentRes.status, 200)

  const { page } = await seedConnectedPage(admin, `page-repair-${Date.now()}`)
  const leadgenId = `lead-repair-${Date.now()}`
  const { MetaWebhookIngestion, Lead, User } = getModels()

  // First import: campaign enrichment fails, other names succeed.
  const ingestion = await MetaWebhookIngestion.create({
    id: uuidv4(),
    companyId: admin.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId,
    formId: 'form-repair',
    dedupeKey: `${admin.companyId}:${page.pageId}:${leadgenId}`,
    status: metaWebhookIngestionStatuses.pending,
    retryCount: 0,
  })

  let campaignCalls = 0
  mockGraphByUrl([
    {
      match: new RegExp(`/${leadgenId}\\?`),
      handle: () => jsonResponse(leadPayload(leadgenId)),
    },
    {
      match: /camp-repair/,
      handle: () => {
        campaignCalls += 1
        if (campaignCalls <= 2) {
          return jsonResponse({ error: { message: 'denied', code: 200 } }, 400)
        }
        return jsonResponse({ name: 'Repaired Camp', effective_status: 'PAUSED' })
      },
    },
    {
      match: /ad-repair|adset-repair|form-repair/,
      handle: () => jsonResponse({ name: 'Obj' }),
    },
  ])

  const first = await processIngestion(ingestion)
  assert.equal(first.status, metaWebhookIngestionStatuses.imported)
  let lead = await Lead.findByPk(first.leadId)
  assert.equal(lead.campaignName, '')
  assert.equal(lead.campaignStatus, '')
  assert.equal(String(lead.primaryAgentId), String(admin.userId))
  assert.equal(leadNeedsMetaRepair(lead), true)

  // Mark imported and run Sync Now — repair path should fill campaign fields.
  await MetaWebhookIngestion.update(
    { status: metaWebhookIngestionStatuses.imported, leadId: lead.id },
    { where: { id: ingestion.id } },
  )

  mockGraphByUrl([
    {
      match: /leadgen_forms/,
      handle: () => jsonResponse({ data: [{ id: 'form-repair', name: 'Form' }] }),
    },
    {
      match: /form-repair\/leads/,
      handle: () => jsonResponse({ data: [leadPayload(leadgenId)] }),
    },
    {
      match: new RegExp(`/${leadgenId}\\?`),
      handle: () => jsonResponse(leadPayload(leadgenId)),
    },
    {
      match: /camp-repair/,
      handle: () => jsonResponse({ name: 'Repaired Camp', effective_status: 'PAUSED' }),
    },
    {
      match: /ad-repair|adset-repair|form-repair/,
      handle: () => jsonResponse({ name: 'Obj' }),
    },
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

  lead = await Lead.findByPk(lead.id)
  assert.equal(lead.campaignName, 'Repaired Camp')
  assert.equal(lead.campaignStatus, 'PAUSED')
  assert.equal(String(lead.primaryAgentId), String(admin.userId))
  assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: leadgenId } }), 1)

  // Non-empty preservation
  const beforeName = lead.campaignName
  await applyMetaMetadataToLead(lead, { campaignName: 'Should Not Win', campaignStatus: 'ACTIVE' })
  await lead.reload()
  assert.equal(lead.campaignName, beforeName)
  assert.equal(lead.campaignStatus, 'PAUSED')

  const stillActive = await User.findByPk(admin.userId)
  assert.equal(stillActive.status, userStatuses.active)
})

test('repair without matching lead does not create a lead', async () => {
  const admin = await registerVerifiedAdmin('EnrichNoLead')
  const { page } = await seedConnectedPage(admin, `page-nolead-${Date.now()}`)
  const leadgenId = `lead-nolead-${Date.now()}`
  const { MetaWebhookIngestion, Lead } = getModels()
  await MetaWebhookIngestion.create({
    id: uuidv4(),
    companyId: admin.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId,
    formId: 'form-repair',
    dedupeKey: `${admin.companyId}:${page.pageId}:${leadgenId}`,
    status: metaWebhookIngestionStatuses.imported,
    retryCount: 0,
  })

  mockGraphByUrl([
    {
      match: /leadgen_forms/,
      handle: () => jsonResponse({ data: [{ id: 'form-repair', name: 'Form' }] }),
    },
    {
      match: /form-repair\/leads/,
      handle: () => jsonResponse({ data: [leadPayload(leadgenId)] }),
    },
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
  assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: leadgenId } }), 0)
})
