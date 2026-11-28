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
process.env.FRONTEND_URL = 'https://crm.example.com'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex')
process.env.WHATSAPP_OUTBOX_AUTORUN = '0'
process.env.WHATSAPP_GRAPH_API_VERSION = 'v27.0'
process.env.WHATSAPP_APP_ID = 'wa-app-111'
process.env.WHATSAPP_APP_SECRET = 'wa-app-secret-222'
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'wa-verify-token'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const {
  resetWhatsAppFetchImpl,
  setWhatsAppFetchImpl,
} = require('../src/services/whatsappCloudClient')
const { assignLead, createLead } = require('../src/services/leadService')
const {
  catalogKinds,
  leadSources,
  roleKeys,
  userStatuses,
  whatsappPhoneRegistrationStatuses,
  whatsappWorkflowKeys,
} = require('../src/utils/enums')
const { messages } = require('../src/utils/messages')
const { errors } = require('../src/utils/errors')
const { hashPassword } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'WaManual') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `wa.manual.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'WA Manual Admin',
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
  const { User, Role, Company } = getModels()
  const user = await User.findByPk(login.body.data.user.id)
  const role = await Role.findByPk(user.roleId)
  const company = await Company.findByPk(user.companyId)
  return {
    token: login.body.data.accessToken,
    companyId: user.companyId,
    userId: user.id,
    auth: {
      userId: user.id,
      companyId: user.companyId,
      roleId: user.roleId,
      sessionId: null,
      user,
      role,
      company,
    },
  }
}

async function createAgent(companyId, email, phone) {
  const { User, Role } = getModels()
  const role = await Role.findOne({ where: { companyId, key: roleKeys.agent } })
  return User.create({
    id: uuidv4(),
    companyId,
    roleId: role.id,
    name: 'Agent',
    email,
    phone,
    passwordHash: await hashPassword('Password1!'),
    status: userStatuses.active,
    emailVerified: true,
  })
}

async function defaultStatusId(companyId) {
  const { CatalogItem } = getModels()
  const status = await CatalogItem.findOne({
    where: { companyId, kind: catalogKinds.status, key: 'new' },
  })
  return status.id
}

before(() => {
  resetWhatsAppFetchImpl()
})

after(() => {
  resetWhatsAppFetchImpl()
})

beforeEach(() => {
  resetWhatsAppFetchImpl()
})

test('manual save stores encrypted token, ignores client display phone, never returns secrets', async () => {
  const admin = await registerVerifiedAdmin()
  const token = `EAA-manual-${uuidv4()}`
  const wabaId = String(Date.now()).slice(-10) + '111'
  const phoneNumberId = String(Date.now()).slice(-10) + '222'
  const save = await request(app)
    .put('/api/whatsapp/config/manual')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      wabaId,
      phoneNumberId,
      accessToken: token,
      displayPhoneNumber: '+971501111111',
      isActive: true,
    })
  assert.equal(save.status, 200)
  assert.equal(save.body.data.config.wabaId, wabaId)
  assert.equal(save.body.data.config.phoneNumberId, phoneNumberId)
  assert.equal(save.body.data.config.tokenStored, true)
  assert.equal(save.body.data.config.displayPhoneNumber, null)
  assert.equal(save.body.data.config.connectionStatus, 'configured')
  assert.equal(save.body.data.config.messagingReady, false)
  assert.equal(Object.prototype.hasOwnProperty.call(save.body.data.config, 'accessToken'), false)
  assert.equal(JSON.stringify(save.body).includes(token), false)

  const { WhatsAppCompanyConfig } = getModels()
  const row = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.ok(row.accessTokenCipher)
  assert.notEqual(row.accessTokenCipher, token)
})

test('verify connection loads display phone and marks messaging ready; test message uses Phone Number ID', async () => {
  const admin = await registerVerifiedAdmin('WaVerify')
  const wabaId = String(Date.now()).slice(-10) + '333'
  const phoneNumberId = String(Date.now()).slice(-10) + '444'
  await request(app)
    .put('/api/whatsapp/config/manual')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      wabaId,
      phoneNumberId,
      accessToken: 'EAA-verify-token',
    })

  setWhatsAppFetchImpl(async (url, init) => {
    if (String(url).includes(`/${phoneNumberId}`) && (!init || init.method === 'GET' || !init.method)) {
      assert.match(String(init.headers.Authorization), /^Bearer /)
      assert.equal(String(init.headers.Authorization).includes('EAA-verify-token'), true)
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: phoneNumberId,
            display_phone_number: '+91 98765 11111',
            verified_name: 'Harmoniq Test',
            quality_rating: { score: 'GREEN' },
          }
        },
      }
    }
    if (String(url).includes('/messages')) {
      const body = JSON.parse(init.body)
      assert.equal(body.to, '919876522222')
      assert.equal(body.template.name, messages.whatsappTestTemplateName)
      assert.match(String(url), new RegExp(`/${phoneNumberId}/messages`))
      assert.equal(String(url).includes('919876522222'), false)
      return {
        ok: true,
        status: 200,
        async json() {
          return { messages: [{ id: 'wamid.test.1' }] }
        },
      }
    }
    return { ok: false, status: 404, async json() { return { error: { message: 'unexpected' } } } }
  })

  const verify = await request(app)
    .post('/api/whatsapp/config/verify')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({})
  assert.equal(verify.status, 200)
  assert.equal(verify.body.data.verified, true)
  assert.equal(verify.body.data.config.connectionStatus, 'connected')
  assert.equal(verify.body.data.config.messagingReady, true)
  assert.equal(verify.body.data.config.displayPhoneNumber, '+919876511111')
  assert.equal(verify.body.data.config.phoneRegistrationStatus, whatsappPhoneRegistrationStatuses.registered)

  const testMsg = await request(app)
    .post('/api/whatsapp/config/test-message')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ recipientPhone: '+91 98765-22222' })
  assert.equal(testMsg.status, 200)
  assert.equal(testMsg.body.data.sent, true)
  assert.equal(testMsg.body.data.providerMessageId, 'wamid.test.1')
  assert.equal(JSON.stringify(testMsg.body).includes('EAA-verify-token'), false)
})

test('invalid test recipient is rejected; W1/W2 still work after manual verify', async () => {
  const admin = await registerVerifiedAdmin('WaW12Manual')
  const wabaId = String(Date.now()).slice(-10) + '555'
  const phoneNumberId = String(Date.now()).slice(-10) + '666'
  await request(app)
    .put('/api/whatsapp/config/manual')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      wabaId,
      phoneNumberId,
      accessToken: 'EAA-w12-token',
    })

  setWhatsAppFetchImpl(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        id: phoneNumberId,
        display_phone_number: '+919800000001',
        verified_name: 'W12',
      }
    },
  }))
  const verify = await request(app)
    .post('/api/whatsapp/config/verify')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({})
  assert.equal(verify.status, 200)
  resetWhatsAppFetchImpl()

  const bad = await request(app)
    .post('/api/whatsapp/config/test-message')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ recipientPhone: '9876543210' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.message, errors.whatsappRecipientInvalid)

  const { WhatsAppTemplate, WhatsAppWorkflowBinding, WhatsAppOutbox } = getModels()
  const template = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'agent_transfer_lead',
    language: 'en_US',
    category: 'UTILITY',
    status: messages.whatsappApprovedTemplateStatus,
    components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}}' }],
    bodyVariableKeys: ['leadName', 'leadPhone', 'agentName'],
    isEnabled: true,
    lastSyncedAt: new Date(),
  })
  await WhatsAppWorkflowBinding.create({
    id: uuidv4(),
    companyId: admin.companyId,
    workflowKey: whatsappWorkflowKeys.transfer,
    templateId: template.id,
  })
  await WhatsAppWorkflowBinding.create({
    id: uuidv4(),
    companyId: admin.companyId,
    workflowKey: whatsappWorkflowKeys.metaAssign,
    templateId: template.id,
  })
  await request(app)
    .patch('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ metaAssignEnabled: true, transferEnabled: true })

  const first = await createAgent(admin.companyId, `first.${Date.now()}@example.com`, '+919811100001')
  const second = await createAgent(admin.companyId, `second.${Date.now()}@example.com`, '+919822200002')
  const statusId = await defaultStatusId(admin.companyId)
  const created = await createLead(admin.auth, {
    name: 'Manual W1 Lead',
    phone: '+919855500001',
    source: leadSources.manual,
    statusId,
    primaryAgentId: first.id,
  })
  assert.equal(await WhatsAppOutbox.count({ where: { companyId: admin.companyId, workflowKey: whatsappWorkflowKeys.metaAssign } }), 1)

  await assignLead(admin.auth, created.lead.id, {
    primaryAgentId: second.id,
    reason: 'Transfer after manual WA',
  })
  const transferRows = await WhatsAppOutbox.findAll({
    where: { companyId: admin.companyId, workflowKey: whatsappWorkflowKeys.transfer },
  })
  assert.equal(transferRows.length, 1)
  assert.equal(transferRows[0].recipientPhone, '+919822200002')
})
