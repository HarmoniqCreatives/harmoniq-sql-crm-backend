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
process.env.APP_BASE_URL = 'https://crm.example.com'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex')
process.env.WHATSAPP_OUTBOX_AUTORUN = '0'
process.env.WHATSAPP_GRAPH_API_VERSION = 'v27.0'
process.env.WHATSAPP_APP_ID = 'wa-app-111'
process.env.WHATSAPP_APP_SECRET = 'wa-app-secret-222'
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'wa-verify-token'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const waCloud = require('../src/services/whatsappCloudClient')
const { upsertConnectedConfigForTests } = require('../src/services/whatsappConfigService')
const {
  extractBodyPlaceholders,
  normalizeMetaTemplateRow,
} = require('../src/services/whatsappTemplateCatalogService')
const {
  whatsappPhoneRegistrationStatuses,
  whatsappWorkflowKeys,
} = require('../src/utils/enums')
const { messages } = require('../src/utils/messages')
const { AppError } = require('../src/utils/errors')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function metaTemplate({
  id,
  name,
  language = 'en_US',
  status = 'APPROVED',
  body = 'Hello {{1}}, lead {{2}}',
  category = 'UTILITY',
}) {
  return {
    id,
    name,
    language,
    status,
    category,
    quality_score: { score: 'GREEN' },
    components: [{ type: 'BODY', text: body }],
  }
}

async function registerVerifiedAdmin(prefix = 'WaTpl') {
  clearMemoryOutbox()
  const email = `wa.tpl.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName: uniqueName(prefix),
    adminName: 'WA Tpl Admin',
    email,
    phone: '+919876543210',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  assert.equal(register.status, 201)
  const link = getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)
  await request(app).post('/api/auth/verify-email').send({
    token: decodeURIComponent(link[1]),
  })
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)
  return {
    token: login.body.data.accessToken,
    companyId: login.body.data.user.company.id,
    userId: login.body.data.user.id,
  }
}

async function connectRegistered(admin, overrides = {}) {
  const wabaId = overrides.wabaId || `waba-${uuidv4().slice(0, 8)}`
  const phoneNumberId = overrides.phoneNumberId || `phone-${uuidv4().slice(0, 8)}`
  await upsertConnectedConfigForTests({
    companyId: admin.companyId,
    userId: admin.userId,
  }, {
    wabaId,
    phoneNumberId,
    accessToken: overrides.accessToken || 'EAA-wa-template-token',
  })
  const { WhatsAppCompanyConfig } = getModels()
  await WhatsAppCompanyConfig.update({
    phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.registered,
    phoneRegisteredAt: new Date(),
    metaAssignEnabled: true,
    transferEnabled: true,
  }, { where: { companyId: admin.companyId } })
  return { wabaId, phoneNumberId }
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

after(() => {
  waCloud.resetWhatsAppFetchImpl()
})

beforeEach(() => {
  waCloud.resetWhatsAppFetchImpl()
})

test('extractBodyPlaceholders supports positional and named tokens', () => {
  const positional = extractBodyPlaceholders([
    { type: 'BODY', text: 'Hi {{1}} from {{2}}' },
  ])
  assert.deepEqual(positional.placeholders, ['1', '2'])
  assert.equal(positional.parameterFormat, 'positional')

  const named = extractBodyPlaceholders([
    { type: 'BODY', text: 'Hi {{lead_name}} / {{agent_name}}' },
  ])
  assert.deepEqual(named.placeholders, ['lead_name', 'agent_name'])
  assert.equal(named.parameterFormat, 'named')
})

test('sync upserts templates, preserves isEnabled, defaults new rows disabled', async () => {
  const admin = await registerVerifiedAdmin('WaSyncOk')
  const { wabaId } = await connectRegistered(admin)
  const { WhatsAppTemplate } = getModels()

  await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'existing_notice',
    language: 'en_US',
    category: 'UTILITY',
    status: 'PENDING',
    components: [{ type: 'BODY', text: 'Old {{1}}' }],
    bodyVariableKeys: ['leadName'],
    isEnabled: true,
    lastSyncedAt: null,
  })

  waCloud.setWhatsAppFetchImpl(async (input) => {
    const url = String(input)
    assert.match(url, /\/message_templates/)
    assert.match(url, /v27\.0/)
    return jsonResponse({
      data: [
        metaTemplate({
          id: 'meta-1',
          name: 'existing_notice',
          status: 'APPROVED',
          body: 'Hello {{1}}',
        }),
        metaTemplate({
          id: 'meta-2',
          name: 'new_notice',
          language: 'en',
          status: 'PENDING',
          body: 'New {{1}} and {{2}}',
        }),
        metaTemplate({
          id: 'meta-3',
          name: 'new_notice',
          language: 'hi',
          status: 'REJECTED',
          body: 'नमस्ते {{1}}',
        }),
      ],
    })
  })

  const synced = await request(app)
    .post('/api/whatsapp/templates/sync')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(synced.status, 200)
  assert.equal(synced.body.data.sync.complete, true)
  assert.equal(synced.body.data.sync.created, 2)
  assert.equal(JSON.stringify(synced.body).includes('EAA-wa-template-token'), false)

  const existing = await WhatsAppTemplate.findOne({
    where: { companyId: admin.companyId, name: 'existing_notice', language: 'en_US' },
  })
  assert.equal(existing.status, 'APPROVED')
  assert.equal(existing.isEnabled, true)
  assert.deepEqual(existing.bodyVariableKeys, ['leadName'])
  assert.equal(existing.metaId, 'meta-1')

  const createdEn = await WhatsAppTemplate.findOne({
    where: { companyId: admin.companyId, name: 'new_notice', language: 'en' },
  })
  assert.equal(createdEn.isEnabled, false)
  assert.deepEqual(createdEn.bodyVariableKeys, [])
  assert.equal(createdEn.status, 'PENDING')

  const createdHi = await WhatsAppTemplate.findOne({
    where: { companyId: admin.companyId, name: 'new_notice', language: 'hi' },
  })
  assert.equal(createdHi.status, 'REJECTED')
  assert.equal(createdHi.isEnabled, false)
})

test('multi-page pagination and incomplete sync does not mark unseen deleted', async () => {
  const admin = await registerVerifiedAdmin('WaSyncPage')
  const { wabaId } = await connectRegistered(admin)
  const { WhatsAppTemplate } = getModels()
  await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'stale_notice',
    language: 'en_US',
    status: 'APPROVED',
    components: [],
    bodyVariableKeys: [],
    isEnabled: true,
  })

  let page = 0
  waCloud.setWhatsAppFetchImpl(async (input) => {
    page += 1
    const url = String(input)
    if (page === 1) {
      return jsonResponse({
        data: [metaTemplate({ id: 'p1', name: 'page_one', body: 'A {{1}}' })],
        paging: {
          next: `https://graph.facebook.com/v27.0/${wabaId}/message_templates?after=cursor1`,
        },
      })
    }
    if (url.includes('after=cursor1')) {
      return jsonResponse({
        data: [metaTemplate({ id: 'p2', name: 'page_two', body: 'B {{1}}' })],
      })
    }
    throw new Error(`Unexpected URL ${url}`)
  })

  const synced = await request(app)
    .post('/api/whatsapp/templates/sync')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(synced.status, 200)
  assert.equal(synced.body.data.sync.pagesFetched, 2)
  assert.equal(synced.body.data.sync.complete, true)
  assert.equal(synced.body.data.sync.markedMissing, 1)

  const stale = await WhatsAppTemplate.findOne({
    where: { companyId: admin.companyId, name: 'stale_notice' },
  })
  assert.equal(stale.status, 'DELETED')
  assert.equal(stale.isEnabled, false)

  // Incomplete: page 2 fails — stale from a fresh company must remain untouched.
  const adminB = await registerVerifiedAdmin('WaSyncPartial')
  const b = await connectRegistered(adminB)
  await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: adminB.companyId,
    wabaId: b.wabaId,
    name: 'keep_me',
    language: 'en_US',
    status: 'APPROVED',
    components: [],
    bodyVariableKeys: [],
    isEnabled: true,
  })
  let calls = 0
  waCloud.setWhatsAppFetchImpl(async () => {
    calls += 1
    if (calls === 1) {
      return jsonResponse({
        data: [metaTemplate({ id: 'only', name: 'partial_one', body: 'X {{1}}' })],
        paging: {
          next: `https://graph.facebook.com/v27.0/${b.wabaId}/message_templates?after=bad`,
        },
      })
    }
    throw new AppError('rate limited', 429, 'WHATSAPP_RATE_LIMITED', { retryable: true })
  })
  const failed = await request(app)
    .post('/api/whatsapp/templates/sync')
    .set('Authorization', `Bearer ${adminB.token}`)
  assert.equal(failed.status, 429)
  const keep = await WhatsAppTemplate.findOne({
    where: { companyId: adminB.companyId, name: 'keep_me' },
  })
  assert.equal(keep.status, 'APPROVED')
  assert.equal(keep.isEnabled, true)
  const cfg = await getModels().WhatsAppCompanyConfig.findOne({
    where: { companyId: adminB.companyId },
  })
  assert.ok(cfg.templatesSyncError)
})

test('binding validation, unbinding, and company isolation', async () => {
  const admin = await registerVerifiedAdmin('WaBind')
  const other = await registerVerifiedAdmin('WaBindOther')
  const { wabaId } = await connectRegistered(admin)
  await connectRegistered(other, {
    wabaId: `waba-o-${uuidv4().slice(0, 6)}`,
    phoneNumberId: `phone-o-${uuidv4().slice(0, 6)}`,
  })
  const { WhatsAppTemplate } = getModels()

  const approved = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'assign_ready',
    language: 'en_US',
    status: messages.whatsappApprovedTemplateStatus,
    components: [{ type: 'BODY', text: 'Hi {{1}} {{2}}' }],
    bodyVariableKeys: ['leadName', 'agentName'],
    isEnabled: true,
  })
  const pending = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'assign_pending',
    language: 'en_US',
    status: 'PENDING',
    components: [{ type: 'BODY', text: 'Hi {{1}}' }],
    bodyVariableKeys: ['leadName'],
    isEnabled: true,
  })
  const foreign = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: other.companyId,
    wabaId: `waba-fx-${uuidv4().slice(0, 6)}`,
    name: 'foreign',
    language: 'en_US',
    status: messages.whatsappApprovedTemplateStatus,
    components: [],
    bodyVariableKeys: [],
    isEnabled: true,
  })

  const badPending = await request(app)
    .put(`/api/whatsapp/workflow-bindings/${whatsappWorkflowKeys.metaAssign}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ templateId: pending.id })
  assert.equal(badPending.status, 400)

  const badForeign = await request(app)
    .put(`/api/whatsapp/workflow-bindings/${whatsappWorkflowKeys.metaAssign}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ templateId: foreign.id })
  assert.equal(badForeign.status, 400)

  const helloWorld = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'hello_world',
    language: 'en_US',
    status: messages.whatsappApprovedTemplateStatus,
    components: [{ type: 'BODY', text: 'Welcome and congratulations!!' }],
    bodyVariableKeys: [],
    isEnabled: true,
  })
  const badHello = await request(app)
    .put(`/api/whatsapp/workflow-bindings/${whatsappWorkflowKeys.transfer}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ templateId: helloWorld.id })
  assert.equal(badHello.status, 400)
  assert.match(String(badHello.body?.error?.message || ''), /hello_world/i)

  const ok = await request(app)
    .put(`/api/whatsapp/workflow-bindings/${whatsappWorkflowKeys.metaAssign}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ templateId: approved.id })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.data.binding.templateId, approved.id)
  assert.equal(ok.body.data.config.workflows.metaAssign.ready, true)

  const listed = await request(app)
    .get('/api/whatsapp/workflow-bindings')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.data.bindings.find((row) => row.workflowKey === 'meta_assign').templateId, approved.id)

  const cleared = await request(app)
    .put(`/api/whatsapp/workflow-bindings/${whatsappWorkflowKeys.metaAssign}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ templateId: null })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.data.binding.templateId, null)

  const otherList = await request(app)
    .get('/api/whatsapp/templates')
    .set('Authorization', `Bearer ${other.token}`)
  assert.equal(otherList.status, 200)
  assert.equal(otherList.body.data.templates.some((row) => row.id === approved.id), false)
})

test('enable requires approved status and mapped variables; patch rejects invalid keys', async () => {
  const admin = await registerVerifiedAdmin('WaEnable')
  const { wabaId } = await connectRegistered(admin)
  const { WhatsAppTemplate } = getModels()
  const template = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'enable_me',
    language: 'en_US',
    status: messages.whatsappApprovedTemplateStatus,
    components: [{ type: 'BODY', text: 'Hi {{1}} {{2}}' }],
    bodyVariableKeys: [],
    isEnabled: false,
  })

  const badEnable = await request(app)
    .patch(`/api/whatsapp/templates/${template.id}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ isEnabled: true })
  assert.equal(badEnable.status, 400)

  const mapped = await request(app)
    .patch(`/api/whatsapp/templates/${template.id}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      bodyVariableKeys: ['leadName', 'agentName'],
      isEnabled: true,
    })
  assert.equal(mapped.status, 200)
  assert.equal(mapped.body.data.template.isEnabled, true)

  const invalidKeys = await request(app)
    .patch(`/api/whatsapp/templates/${template.id}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ bodyVariableKeys: ['leadName', 'notARealKey'] })
  assert.equal(invalidKeys.status, 400)
})

test('normalizeMetaTemplateRow ignores malformed rows', () => {
  assert.equal(normalizeMetaTemplateRow({ name: '', language: 'en' }), null)
  const ok = normalizeMetaTemplateRow(metaTemplate({
    id: 'x',
    name: 'ok',
    body: 'Hello {{1}}',
  }))
  assert.equal(ok.name, 'ok')
  assert.equal(ok.placeholderCount, 1)
  assert.equal(ok.quality, 'GREEN')
})

test('expired token and untrusted paging URL fail safely', async () => {
  const admin = await registerVerifiedAdmin('WaSyncErr')
  await connectRegistered(admin)

  waCloud.setWhatsAppFetchImpl(async () => jsonResponse({
    error: { code: 190, message: 'Invalid OAuth access token' },
  }, 401))
  const expired = await request(app)
    .post('/api/whatsapp/templates/sync')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(expired.status, 401)

  waCloud.setWhatsAppFetchImpl(async () => jsonResponse({
    data: [metaTemplate({ id: '1', name: 'a', body: 'A {{1}}' })],
    paging: { next: 'https://evil.example/v27.0/hack' },
  }))
  const untrusted = await request(app)
    .post('/api/whatsapp/templates/sync')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(untrusted.status, 502)
})
