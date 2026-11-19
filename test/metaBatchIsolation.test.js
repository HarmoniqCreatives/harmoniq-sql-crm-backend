const assert = require('node:assert/strict')
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
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const metaLeadService = require('../src/services/metaLeadService')
const {
  processDueIngestions,
  processIngestion,
  startPageLeadSync,
  processSyncJobById,
  isFatalMetaGraphError,
} = metaLeadService
const graphClient = require('../src/services/metaGraph')
const { encryptSecret } = require('../src/utils/metaSecrets')
const { AppError, errors } = require('../src/utils/errors')
const { metaWebhookIngestionStatuses } = require('../src/utils/enums')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'BatchIso') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `batch.iso.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Batch Admin',
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
    created_time: '2024-06-01T12:00:00+0000',
    form_id: overrides.form_id || 'form-batch',
    campaign_id: overrides.campaign_id || 'camp-batch',
    adset_id: 'adset-batch',
    ad_id: 'ad-batch',
    field_data: [
      { name: 'full_name', values: [overrides.name || 'Batch Lead'] },
      { name: 'phone_number', values: [overrides.phone || '+971501111222'] },
      ...(overrides.email === null
        ? []
        : [{ name: 'email', values: [overrides.email || 'batch@example.com'] }]),
    ],
  }
}

async function seedConnectedPage(admin, pageId) {
  const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
  const profile = await MetaAppProfile.create({
    id: uuidv4(),
    companyId: admin.companyId,
    mode: 'customer',
    label: `Batch ${pageId}`,
    appId: 'app-batch',
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
    displayName: 'Batch FB',
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
  return { page }
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
    formId: 'form-batch',
    dedupeKey: `${admin.companyId}:${page.pageId}:${leadgenId}`,
    status: metaWebhookIngestionStatuses.pending,
    retryCount: 0,
    nextAttemptAt: null,
    lastError: '',
  })
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

test('isFatalMetaGraphError only matches token/permission/rate-limit', () => {
  assert.equal(isFatalMetaGraphError(new AppError(errors.metaTokenExpired, 401)), true)
  assert.equal(isFatalMetaGraphError(new AppError(errors.metaRateLimited, 429)), true)
  assert.equal(isFatalMetaGraphError(new Error('unexpected boom')), false)
  assert.equal(isFatalMetaGraphError(new AppError(errors.metaLeadIncomplete, 400)), false)
})

test('sync continues after unexpected per-lead exception and imports the next valid lead', async () => {
  const admin = await registerVerifiedAdmin('SyncIso')
  const { page } = await seedConnectedPage(admin, `page-sync-iso-${Date.now()}`)
  const boomId = `lead-boom-${Date.now()}`
  const okId = `lead-ok-${Date.now()}`

  const original = metaLeadService.processIngestion
  metaLeadService.processIngestion = async (ingestion, graph) => {
    if (ingestion.leadgenId === boomId) {
      throw new Error('unexpected per-lead boom')
    }
    return original(ingestion, graph)
  }

  mockGraphSequential([
    () => jsonResponse({ data: [{ id: 'form-batch', name: 'Form' }] }),
    () => jsonResponse({
      data: [
        leadPayload(boomId, { phone: '+971501000001', name: 'Boom Lead' }),
        leadPayload(okId, { phone: '9876543210', name: 'Ok Lead' }),
      ],
    }),
    () => jsonResponse(leadPayload(okId, { phone: '9876543210', name: 'Ok Lead' })),
    () => jsonResponse({ name: 'Campaign', effective_status: 'ACTIVE' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])

  try {
    const started = await startPageLeadSync(
      { companyId: admin.companyId, userId: admin.userId },
      page.id,
      {},
    )
    await processSyncJobById(started.id)
    const { MetaSyncJob, Lead, MetaWebhookIngestion } = getModels()
    const job = await MetaSyncJob.findByPk(started.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.imported >= 1, true)
    assert.equal(job.failed >= 1, true)
    assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: okId } }), 1)
    assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: boomId } }), 0)
    const boomRow = await MetaWebhookIngestion.findOne({
      where: { companyId: admin.companyId, leadgenId: boomId },
    })
    assert.ok(boomRow)
    assert.equal(boomRow.status, metaWebhookIngestionStatuses.failed)
  } finally {
    metaLeadService.processIngestion = original
  }
})

test('webhook worker continues after one ingestion throws', async () => {
  const admin = await registerVerifiedAdmin('HookIso')
  const { page } = await seedConnectedPage(admin, `page-hook-iso-${Date.now()}`)
  const boomId = `hook-boom-${Date.now()}`
  const okId = `hook-ok-${Date.now()}`
  await seedPendingIngestion(admin, page, boomId)
  await seedPendingIngestion(admin, page, okId)

  const original = metaLeadService.processIngestion
  metaLeadService.processIngestion = async (ingestion, graph) => {
    if (ingestion.leadgenId === boomId) {
      throw new Error('webhook boom')
    }
    return original(ingestion, graph)
  }

  mockGraphSequential([
    () => jsonResponse(leadPayload(okId, { phone: '+919876543210', name: 'Hook Ok' })),
    () => jsonResponse({ name: 'Campaign', effective_status: 'ACTIVE' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])

  try {
    await processDueIngestions()
    const { Lead, MetaWebhookIngestion } = getModels()
    assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: okId } }), 1)
    const boomRow = await MetaWebhookIngestion.findOne({
      where: { companyId: admin.companyId, leadgenId: boomId },
    })
    assert.equal(boomRow.status, metaWebhookIngestionStatuses.failed)
  } finally {
    metaLeadService.processIngestion = original
  }
})

test('Meta import accepts local phone without plus using company timezone dial', async () => {
  const admin = await registerVerifiedAdmin('PhoneLocal')
  const { Company } = getModels()
  const company = await Company.findByPk(admin.companyId)
  company.timezone = 'Asia/Kolkata'
  await company.save()

  const { page } = await seedConnectedPage(admin, `page-phone-local-${Date.now()}`)
  const leadgenId = `lead-local-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)
  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, {
      name: 'Local Phone',
      phone: '09876543210',
      email: null,
    })),
    () => jsonResponse({ name: 'Campaign', effective_status: 'ACTIVE' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])
  const result = await processIngestion(ingestion)
  assert.equal(result.status, metaWebhookIngestionStatuses.imported)
  const { Lead } = getModels()
  const lead = await Lead.findByPk(result.leadId)
  assert.equal(lead.phone, '+919876543210')
})

test('Meta import rejects invalid phone and missing name; duplicate still skipped', async () => {
  const admin = await registerVerifiedAdmin('PhoneReject')
  const { page } = await seedConnectedPage(admin, `page-phone-rej-${Date.now()}`)
  const { Lead } = getModels()

  const badId = `lead-badph-${Date.now()}`
  const badIng = await seedPendingIngestion(admin, page, badId)
  mockGraphSequential([
    () => jsonResponse(leadPayload(badId, { name: 'Bad Phone', phone: '12' })),
  ])
  const bad = await processIngestion(badIng)
  assert.equal(bad.status, metaWebhookIngestionStatuses.failed)
  assert.equal(bad.lastError, errors.metaLeadIncomplete)

  graphClient.resetFetchImpl()
  const noNameId = `lead-noname-${Date.now()}`
  const noNameIng = await seedPendingIngestion(admin, page, noNameId)
  mockGraphSequential([
    () => jsonResponse({
      id: noNameId,
      created_time: '2024-06-01T12:00:00+0000',
      form_id: 'form-batch',
      campaign_id: 'camp-batch',
      adset_id: 'adset-batch',
      ad_id: 'ad-batch',
      field_data: [{ name: 'phone_number', values: ['+919876543210'] }],
    }),
  ])
  const noName = await processIngestion(noNameIng)
  assert.equal(noName.status, metaWebhookIngestionStatuses.failed)

  graphClient.resetFetchImpl()
  const dupId = `lead-dup-iso-${Date.now()}`
  const first = await seedPendingIngestion(admin, page, dupId)
  mockGraphSequential([
    () => jsonResponse(leadPayload(dupId, { phone: '+971509998877', name: 'Dup' })),
    () => jsonResponse({ name: 'Campaign', effective_status: 'ACTIVE' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])
  const imported = await processIngestion(first)
  assert.equal(imported.status, metaWebhookIngestionStatuses.imported)

  graphClient.resetFetchImpl()
  first.status = metaWebhookIngestionStatuses.pending
  first.retryCount = 0
  await first.save()
  mockGraphSequential([
    () => jsonResponse(leadPayload(dupId, { phone: '+971509998877', name: 'Dup' })),
    () => jsonResponse({ name: 'Campaign', effective_status: 'ACTIVE' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ])
  const second = await processIngestion(first)
  assert.ok(
    second.status === metaWebhookIngestionStatuses.skipped
      || second.status === metaWebhookIngestionStatuses.imported,
  )
  assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: dupId } }), 1)
})

test('manual Lead creation validations remain unchanged', async () => {
  const admin = await registerVerifiedAdmin('ManualKeep')
  const statuses = await request(app)
    .get('/api/catalog?kind=STATUS')
    .set('Authorization', `Bearer ${admin.token}`)
  const statusId = statuses.body.data.items.find((row) => row.key === 'new').id

  const badEmail = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Manual', phone: '+919876543210', email: 'not-valid', statusId })
  assert.equal(badEmail.status, 400)

  const localPhone = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Manual', phone: '9876543210', statusId })
  assert.equal(localPhone.status, 400)

  const ok = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Manual Ok', phone: '+919876543210', statusId })
  assert.equal(ok.status, 201)
})
