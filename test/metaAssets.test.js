const {
  isolatedTestDbConfigured,
  applyIsolatedTestDbEnv,
  assertIsolatedTestDbOrThrow,
} = require('./helpers/isolatedTestDb')
assertIsolatedTestDbOrThrow()
applyIsolatedTestDbEnv()

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
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { clearMetaAssetCache } = require('../src/services/metaAssetsService')
const { processIngestion } = require('../src/services/metaLeadService')
const graphClient = require('../src/services/metaGraph')
const { encryptSecret } = require('../src/utils/metaSecrets')
const { errors } = require('../src/utils/errors')
const { metaWebhookIngestionStatuses } = require('../src/utils/enums')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'Assets') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `assets.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Assets Admin',
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
    for (const entry of handlers) {
      if (entry.match.test(url)) {
        return entry.handle(url)
      }
    }
    throw new Error(`Unexpected Graph call: ${url}`)
  })
}

async function seedConnectedPage(admin, pageId, options = {}) {
  const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
  const profile = await MetaAppProfile.create({
    id: uuidv4(),
    companyId: admin.companyId,
    mode: 'customer',
    label: `Assets ${pageId}`,
    appId: 'app-assets',
    appSecretCipher: encryptSecret('secret'),
    secretStored: true,
    isActive: true,
    createdBy: admin.userId,
    updatedBy: admin.userId,
  })
  const granted = options.granted || [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'leads_retrieval',
    'ads_read',
  ]
  const connection = await MetaConnection.create({
    id: uuidv4(),
    companyId: admin.companyId,
    appProfileId: profile.id,
    metaUserId: `mu-${pageId}`,
    displayName: 'Assets FB',
    status: 'connected',
    grantedPermissions: granted,
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
  return { page, connection }
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
  clearMetaAssetCache()
})

test('GET forms returns leadgen forms for the company page', async () => {
  const admin = await registerVerifiedAdmin('FormsOk')
  const { page } = await seedConnectedPage(admin, `page-forms-${Date.now()}`)
  mockGraphByUrl([
    {
      match: /leadgen_forms/,
      handle: () => jsonResponse({
        data: [
          {
            id: 'form-1',
            name: 'Main Form',
            status: 'ACTIVE',
            locale: 'en_US',
            leads_count: 3,
          },
        ],
      }),
    },
  ])
  const response = await request(app)
    .get(`/api/meta/pages/${page.id}/forms`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.data.forms.length, 1)
  assert.equal(response.body.data.forms[0].name, 'Main Form')
  assert.equal(response.body.data.forms[0].status, 'ACTIVE')
  assert.equal(JSON.stringify(response.body).includes('page-token'), false)
})

test('GET forms is company-isolated', async () => {
  const a = await registerVerifiedAdmin('FormsA')
  const b = await registerVerifiedAdmin('FormsB')
  const { page } = await seedConnectedPage(a, `page-iso-${Date.now()}`)
  const response = await request(app)
    .get(`/api/meta/pages/${page.id}/forms`)
    .set('Authorization', `Bearer ${b.token}`)
  assert.equal(response.status, 404)
})

test('GET campaigns requires ads_read and resolves ad accounts', async () => {
  const admin = await registerVerifiedAdmin('CampOk')
  const { page } = await seedConnectedPage(admin, `page-camp-${Date.now()}`)
  mockGraphByUrl([
    {
      match: /fields=business/,
      handle: () => jsonResponse({ id: page.pageId, business: null }),
    },
    {
      match: /me\/adaccounts/,
      handle: () => jsonResponse({
        data: [{ id: 'act_100', account_id: '100', name: 'Ad Account', account_status: 1 }],
      }),
    },
    {
      match: /act_100\/campaigns/,
      handle: () => jsonResponse({
        data: [{
          id: 'camp-1',
          name: 'Summer',
          effective_status: 'ACTIVE',
          status: 'ACTIVE',
          objective: 'OUTCOME_LEADS',
        }],
      }),
    },
  ])
  const response = await request(app)
    .get(`/api/meta/pages/${page.id}/campaigns`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.data.campaigns.length, 1)
  assert.equal(response.body.data.campaigns[0].name, 'Summer')
  assert.equal(response.body.data.campaigns[0].effectiveStatus, 'ACTIVE')
})

test('GET campaigns fails clearly without ads_read', async () => {
  const admin = await registerVerifiedAdmin('CampPerm')
  const { page } = await seedConnectedPage(admin, `page-camp-perm-${Date.now()}`, {
    granted: ['pages_show_list', 'leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement'],
  })
  const response = await request(app)
    .get(`/api/meta/pages/${page.id}/campaigns`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 403)
  assert.match(response.body.error.message, /permission/i)
})

test('GET ads returns real ads rows', async () => {
  const admin = await registerVerifiedAdmin('AdsOk')
  const { page } = await seedConnectedPage(admin, `page-ads-${Date.now()}`)
  mockGraphByUrl([
    {
      match: /fields=business/,
      handle: () => jsonResponse({
        id: page.pageId,
        business: {
          id: 'biz-1',
          owned_ad_accounts: {
            data: [{ id: 'act_200', account_id: '200', name: 'Biz Ads', account_status: 1 }],
          },
        },
      }),
    },
    {
      match: /act_200\/ads/,
      handle: () => jsonResponse({
        data: [{
          id: 'ad-1',
          name: 'Lead Ad',
          effective_status: 'ACTIVE',
          status: 'ACTIVE',
          campaign_id: 'camp-9',
          adset_id: 'adset-9',
        }],
      }),
    },
  ])
  const response = await request(app)
    .get(`/api/meta/pages/${page.id}/ads`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.data.ads.length, 1)
  assert.equal(response.body.data.ads[0].campaignId, 'camp-9')
  assert.equal(response.body.data.adAccountSource, 'page_business')
})

test('GET campaigns returns meaningful error when no ad accounts', async () => {
  const admin = await registerVerifiedAdmin('CampEmpty')
  const { page } = await seedConnectedPage(admin, `page-camp-empty-${Date.now()}`)
  mockGraphByUrl([
    {
      match: /fields=business/,
      handle: () => jsonResponse({ id: page.pageId }),
    },
    {
      match: /me\/adaccounts/,
      handle: () => jsonResponse({ data: [] }),
    },
  ])
  const response = await request(app)
    .get(`/api/meta/pages/${page.id}/campaigns`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 404)
  assert.equal(response.body.error.message, errors.metaAdAccountNotFound)
})

test('campaign enrichment falls back to user token when page token fails', async () => {
  const admin = await registerVerifiedAdmin('Enrich')
  const { page } = await seedConnectedPage(admin, `page-enrich-${Date.now()}`)
  const { MetaWebhookIngestion } = getModels()
  const leadgenId = `lead-enrich-${Date.now()}`
  const ingestion = await MetaWebhookIngestion.create({
    id: uuidv4(),
    companyId: admin.companyId,
    metaPageId: page.id,
    connectionId: page.connectionId,
    pageId: page.pageId,
    leadgenId,
    formId: 'form-enrich',
    dedupeKey: `${admin.companyId}:${page.pageId}:${leadgenId}`,
    status: metaWebhookIngestionStatuses.pending,
    retryCount: 0,
  })

  let campaignCalls = 0
  mockGraphByUrl([
    {
      match: new RegExp(`/${leadgenId}\\?`),
      handle: () => jsonResponse({
        id: leadgenId,
        created_time: '2024-06-01T12:00:00+0000',
        form_id: 'form-enrich',
        campaign_id: 'camp-enrich',
        adset_id: 'adset-enrich',
        ad_id: 'ad-enrich',
        field_data: [
          { name: 'full_name', values: ['Enrich Lead'] },
          { name: 'phone_number', values: ['+971501234567'] },
        ],
      }),
    },
    {
      match: /camp-enrich/,
      handle: () => {
        campaignCalls += 1
        if (campaignCalls === 1) {
          return jsonResponse({ error: { message: 'page token denied', code: 200 } }, 400)
        }
        return jsonResponse({ name: 'Real Campaign', effective_status: 'PAUSED' })
      },
    },
    {
      match: /adset-enrich|ad-enrich|form-enrich/,
      handle: () => jsonResponse({ name: 'Obj' }),
    },
  ])

  const result = await processIngestion(ingestion)
  assert.equal(result.status, metaWebhookIngestionStatuses.imported)
  const { Lead } = getModels()
  const lead = await Lead.findByPk(result.leadId)
  assert.equal(lead.campaignName, 'Real Campaign')
  assert.equal(lead.campaignStatus, 'PAUSED')
  assert.ok(campaignCalls >= 2)
})
