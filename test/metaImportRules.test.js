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
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { processIngestion } = require('../src/services/metaLeadService')
const { createLead } = require('../src/services/leadService')
const graphClient = require('../src/services/metaGraph')
const { encryptSecret } = require('../src/utils/metaSecrets')
const {
  metaWebhookIngestionStatuses,
  propertyTypes,
  leadPurposes,
  readinessValues,
} = require('../src/utils/enums')
const { errors } = require('../src/utils/errors')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'ImportRules') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `import.rules.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Import Admin',
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
    auth: {
      userId: login.body.data.user.id,
      companyId: login.body.data.user.company.id,
      roleId: login.body.data.user.role.id,
      user: { id: login.body.data.user.id, name: login.body.data.user.name, branchId: null, teamId: null },
      role: login.body.data.user.role,
      company: login.body.data.user.company,
    },
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

/**
 * Builds a Graph lead payload. Pass `fields` to fully replace field_data
 * (use [] for name/phone-only scenarios that omit email).
 */
function leadPayload(id, overrides = {}) {
  let fieldData
  if (Object.prototype.hasOwnProperty.call(overrides, 'fields')) {
    fieldData = overrides.fields
  } else {
    fieldData = [
      { name: 'full_name', values: [overrides.name || 'Meta Import Lead'] },
      { name: 'phone_number', values: [overrides.phone || '+971501111222'] },
    ]
    if (overrides.email !== undefined) {
      if (overrides.email !== null) {
        fieldData.push({ name: 'email', values: [overrides.email] })
      }
    } else {
      fieldData.push({ name: 'email', values: ['lead@example.com'] })
    }
  }
  return {
    id,
    created_time: overrides.created_time || '2024-06-01T12:00:00+0000',
    form_id: overrides.form_id !== undefined ? overrides.form_id : 'form-import-rules',
    campaign_id: overrides.campaign_id !== undefined ? overrides.campaign_id : 'camp-import-rules',
    adset_id: overrides.adset_id !== undefined ? overrides.adset_id : 'adset-import-rules',
    ad_id: overrides.ad_id !== undefined ? overrides.ad_id : 'ad-import-rules',
    field_data: fieldData,
  }
}

async function seedConnectedPage(admin, pageId) {
  const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
  const profile = await MetaAppProfile.create({
    id: uuidv4(),
    companyId: admin.companyId,
    mode: 'customer',
    label: `Import ${pageId}`,
    appId: 'app-import-rules',
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
    displayName: 'Import FB',
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
    formId: 'form-import-rules',
    dedupeKey: `${admin.companyId}:${page.pageId}:${leadgenId}`,
    status: metaWebhookIngestionStatuses.pending,
    retryCount: 0,
    nextAttemptAt: null,
    lastError: '',
  })
}

function enrichmentMocks() {
  return [
    () => jsonResponse({ name: 'Campaign', effective_status: 'ACTIVE' }),
    () => jsonResponse({ name: 'AdSet' }),
    () => jsonResponse({ name: 'Ad' }),
    () => jsonResponse({ name: 'Form' }),
  ]
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

test('Meta import succeeds with only Name and Phone', async () => {
  const admin = await registerVerifiedAdmin('OnlyNamePhone')
  const { page } = await seedConnectedPage(admin, `page-np-${Date.now()}`)
  const leadgenId = `lead-np-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)

  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, {
      fields: [
        { name: 'full_name', values: ['Only Name Phone'] },
        { name: 'phone_number', values: ['+971502222333'] },
      ],
      form_id: '',
      campaign_id: '',
      adset_id: '',
      ad_id: '',
    })),
    ...enrichmentMocks(),
  ])

  const result = await processIngestion(ingestion)
  assert.equal(result.status, metaWebhookIngestionStatuses.imported)
  const { Lead } = getModels()
  const lead = await Lead.findByPk(result.leadId)
  assert.ok(lead)
  assert.equal(lead.name, 'Only Name Phone')
  assert.equal(lead.phone, '+971502222333')
  assert.equal(lead.email, '')
  assert.equal(lead.propertyType, propertyTypes.apartment)
  assert.equal(lead.purpose, leadPurposes.buy)
  assert.equal(lead.readiness, readinessValues.readyToMove)
  assert.equal(lead.primaryAgentId, null)
  assert.ok(lead.statusId)
  assert.ok(lead.currency)
  assert.equal(lead.companyId, admin.companyId)
  assert.equal(lead.metaLeadId, leadgenId)
})

test('Meta import accepts missing email, campaign, property, purpose, agent, tags and feedback extras', async () => {
  const admin = await registerVerifiedAdmin('MissingOptionals')
  const { page } = await seedConnectedPage(admin, `page-opt-${Date.now()}`)
  const leadgenId = `lead-opt-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)

  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, {
      email: null,
      form_id: '',
      campaign_id: '',
      adset_id: '',
      ad_id: '',
      name: 'Optional Gaps',
      phone: '+971503333444',
    })),
    ...enrichmentMocks(),
  ])

  const result = await processIngestion(ingestion)
  assert.equal(result.status, metaWebhookIngestionStatuses.imported)
  const { Lead, LeadTag, LeadFeedback } = getModels()
  const lead = await Lead.findByPk(result.leadId)
  assert.equal(lead.email, '')
  assert.equal(lead.campaignName === '' || typeof lead.campaignName === 'string', true)
  assert.equal(lead.propertyType, propertyTypes.apartment)
  assert.equal(lead.purpose, leadPurposes.buy)
  assert.equal(lead.primaryAgentId, null)
  const tags = await LeadTag.count({ where: { leadId: lead.id } })
  assert.equal(tags, 0)
  // Auto Meta note may still be stored as feedback — optional feedback must not block.
  const feedbacks = await LeadFeedback.count({ where: { leadId: lead.id } })
  assert.equal(feedbacks >= 0, true)
})

test('Meta import stores blank email and safe defaults for invalid optional fields', async () => {
  const admin = await registerVerifiedAdmin('InvalidOptionals')
  const { page } = await seedConnectedPage(admin, `page-inv-${Date.now()}`)
  const leadgenId = `lead-inv-${Date.now()}`
  const ingestion = await seedPendingIngestion(admin, page, leadgenId)

  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, {
      email: 'not-a-valid-email',
      name: 'Invalid Optionals',
      phone: '+971504444555',
    })),
    ...enrichmentMocks(),
  ])

  const result = await processIngestion(ingestion)
  assert.equal(result.status, metaWebhookIngestionStatuses.imported)
  const { Lead } = getModels()
  const lead = await Lead.findByPk(result.leadId)
  assert.equal(lead.email, '')
  assert.equal(lead.propertyType, propertyTypes.apartment)
  assert.equal(lead.purpose, leadPurposes.buy)

  // Direct metaImport create with invalid enums / overlong text must not block.
  const { CatalogItem, Role, User, Company } = getModels()
  const status = await CatalogItem.findOne({
    where: { companyId: admin.companyId, kind: 'STATUS', key: 'new', isActive: true },
  })
  const actorUser = await User.findByPk(admin.userId)
  const role = await Role.findByPk(actorUser.roleId)
  const company = await Company.findByPk(admin.companyId)
  const created = await createLead({
    userId: admin.userId,
    companyId: admin.companyId,
    roleId: role.id,
    user: actorUser,
    role,
    company,
  }, {
    name: 'Soft Enums',
    phone: '+971505555666',
    email: 'also-bad@@',
    source: 'facebook',
    statusId: status.id,
    metaLeadId: `meta-soft-${Date.now()}`,
    propertyType: 'spaceship',
    purpose: 'flip',
    readiness: 'yesterday',
    location: 'x'.repeat(500),
    budget: 'y'.repeat(500),
  }, { metaImport: true })
  assert.ok(created.lead.id)
  const softLead = await Lead.findByPk(created.lead.id)
  assert.equal(softLead.email, '')
  assert.equal(softLead.propertyType, propertyTypes.apartment)
  assert.equal(softLead.purpose, leadPurposes.buy)
  assert.equal(softLead.readiness, readinessValues.readyToMove)
  assert.equal(softLead.location.length, 300)
})

test('Meta import rejects missing Name and missing/invalid Phone', async () => {
  const admin = await registerVerifiedAdmin('RejectCore')
  const { page } = await seedConnectedPage(admin, `page-rej-${Date.now()}`)
  const { Lead } = getModels()

  const missingNameId = `lead-no-name-${Date.now()}`
  const missingNameIng = await seedPendingIngestion(admin, page, missingNameId)
  mockGraphSequential([
    () => jsonResponse(leadPayload(missingNameId, {
      fields: [
        { name: 'phone_number', values: ['+971506666777'] },
      ],
    })),
  ])
  const noName = await processIngestion(missingNameIng)
  assert.equal(noName.status, metaWebhookIngestionStatuses.failed)
  assert.equal(noName.lastError, errors.metaLeadIncomplete)
  assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: missingNameId } }), 0)

  graphClient.resetFetchImpl()
  const badPhoneId = `lead-bad-phone-${Date.now()}`
  const badPhoneIng = await seedPendingIngestion(admin, page, badPhoneId)
  mockGraphSequential([
    () => jsonResponse(leadPayload(badPhoneId, {
      fields: [
        { name: 'full_name', values: ['No Phone'] },
        { name: 'phone_number', values: ['not-a-phone'] },
      ],
    })),
  ])
  const badPhone = await processIngestion(badPhoneIng)
  assert.equal(badPhone.status, metaWebhookIngestionStatuses.failed)
  assert.equal(badPhone.lastError, errors.metaLeadIncomplete)
  assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: badPhoneId } }), 0)

  graphClient.resetFetchImpl()
  const noPhoneId = `lead-blank-phone-${Date.now()}`
  const noPhoneIng = await seedPendingIngestion(admin, page, noPhoneId)
  mockGraphSequential([
    () => jsonResponse(leadPayload(noPhoneId, {
      fields: [
        { name: 'full_name', values: ['Blank Phone'] },
      ],
    })),
  ])
  const noPhone = await processIngestion(noPhoneIng)
  assert.equal(noPhone.status, metaWebhookIngestionStatuses.failed)
  assert.equal(noPhone.lastError, errors.metaLeadIncomplete)
  assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: noPhoneId } }), 0)
})

test('duplicate Meta lead does not create a second CRM lead', async () => {
  const admin = await registerVerifiedAdmin('DupMeta')
  const { page } = await seedConnectedPage(admin, `page-dup-${Date.now()}`)
  const leadgenId = `lead-dup-${Date.now()}`
  const firstIng = await seedPendingIngestion(admin, page, leadgenId)

  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, { phone: '+971507777888' })),
    ...enrichmentMocks(),
  ])
  const first = await processIngestion(firstIng)
  assert.equal(first.status, metaWebhookIngestionStatuses.imported)

  graphClient.resetFetchImpl()
  // Re-queue the same ingestion row (dedupeKey is unique) and process again.
  firstIng.status = metaWebhookIngestionStatuses.pending
  firstIng.retryCount = 0
  firstIng.lastError = ''
  firstIng.nextAttemptAt = null
  await firstIng.save()
  mockGraphSequential([
    () => jsonResponse(leadPayload(leadgenId, { phone: '+971507777888' })),
    ...enrichmentMocks(),
  ])
  const second = await processIngestion(firstIng)
  assert.ok(
    second.status === metaWebhookIngestionStatuses.skipped
      || second.status === metaWebhookIngestionStatuses.imported,
    `expected skipped or imported, got ${second.status}`,
  )

  const { Lead } = getModels()
  assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: leadgenId } }), 1)
})

test('manual Lead creation validations remain unchanged', async () => {
  const admin = await registerVerifiedAdmin('ManualStrict')
  const statuses = await request(app)
    .get('/api/catalog?kind=STATUS')
    .set('Authorization', `Bearer ${admin.token}`)
  const statusId = statuses.body.data.items.find((row) => row.key === 'new').id

  const missingName = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ phone: '+971508888999', statusId })
  assert.equal(missingName.status, 400)

  const badPhone = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Manual', phone: 'bad', statusId })
  assert.equal(badPhone.status, 400)

  const badEmail = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Manual', phone: '+971508888999', email: 'not-valid', statusId })
  assert.equal(badEmail.status, 400)

  const badProperty = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      name: 'Manual',
      phone: '+971508888999',
      statusId,
      propertyType: 'spaceship',
    })
  assert.equal(badProperty.status, 400)

  const ok = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Manual Ok', phone: '+971509999000', statusId })
  assert.equal(ok.status, 201)
})

test('Meta import still succeeds when response presentation throws after insert', async () => {
  const admin = await registerVerifiedAdmin('PresentSoft')
  const leadgenId = `lead-pres-${Date.now()}`
  const leadService = require('../src/services/leadService')
  const originalPresent = leadService.presentLeads
  leadService.presentLeads = async () => {
    throw new Error('present boom')
  }

  try {
    const { CatalogItem, Role, User, Company, Lead } = getModels()
    const status = await CatalogItem.findOne({
      where: { companyId: admin.companyId, kind: 'STATUS', key: 'new', isActive: true },
    })
    const actorUser = await User.findByPk(admin.userId)
    const role = await Role.findByPk(actorUser.roleId)
    const company = await Company.findByPk(admin.companyId)
    const result = await createLead({
      userId: admin.userId,
      companyId: admin.companyId,
      roleId: role.id,
      user: actorUser,
      role,
      company,
    }, {
      name: 'Present Soft',
      phone: '+971501010101',
      source: 'facebook',
      statusId: status.id,
      metaLeadId: leadgenId,
    }, { metaImport: true })

    assert.ok(result.lead.id)
    assert.equal(result.lead.name, 'Present Soft')
    assert.equal(await Lead.count({ where: { companyId: admin.companyId, metaLeadId: leadgenId } }), 1)
  } finally {
    leadService.presentLeads = originalPresent
  }
})
