const assert = require('node:assert/strict')
const { after, before, beforeEach, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = 'http://localhost:5174'
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
const {
  claimOutboxJobs,
  enqueueWhatsAppMessage,
  processOutboxJob,
  finalizeOutboxFailure,
  stopWhatsAppOutboxWorker,
} = require('../src/services/whatsappOutboxService')

before(() => {
  // Tests drive claim/process explicitly; never leave an in-process poller running.
  process.env.WHATSAPP_OUTBOX_AUTORUN = '0'
  stopWhatsAppOutboxWorker()
})
const { upsertConnectedConfigForTests } = require('../src/services/whatsappConfigService')
const {
  permissionKeys,
  roleKeys,
  whatsappAuditActions,
  whatsappMessageStatuses,
  whatsappOutboxStatuses,
  whatsappPhoneRegistrationStatuses,
} = require('../src/utils/enums')
const { AppError } = require('../src/utils/errors')
const { messages } = require('../src/utils/messages')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'WaMsg') {
  clearMemoryOutbox()
  const email = `wa.msg.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName: uniqueName(prefix),
    adminName: 'WA Msg Admin',
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

async function inviteAgent(admin) {
  const roles = await request(app)
    .get('/api/roles')
    .set('Authorization', `Bearer ${admin.token}`)
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const email = `wa.msg.agent.${Date.now()}@example.com`
  const invite = await request(app)
    .post('/api/invitations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Agent', email, roleId: agentRole.id })
  const inviteToken = new URL(invite.body.data.link).searchParams.get('token')
  await request(app).post('/api/invitations/accept').send({
    token: inviteToken,
    password: 'Password2!',
    confirmPassword: 'Password2!',
  })
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password2!',
  })
  return { token: login.body.data.accessToken }
}

async function connectCompany(admin, overrides = {}) {
  const wabaId = overrides.wabaId || `waba-${uuidv4().slice(0, 8)}`
  const phoneNumberId = overrides.phoneNumberId || `phone-${uuidv4().slice(0, 8)}`
  await upsertConnectedConfigForTests({
    companyId: admin.companyId,
    userId: admin.userId,
  }, {
    wabaId,
    phoneNumberId,
    accessToken: overrides.accessToken || 'EAA-wa-token-secret',
    displayPhoneNumber: '+15550100',
  })
  return { wabaId, phoneNumberId }
}

async function markRegistered(companyId) {
  const { WhatsAppCompanyConfig } = getModels()
  await WhatsAppCompanyConfig.update({
    phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.registered,
    phoneRegisteredAt: new Date(),
    phoneRegistrationError: '',
    wabaWebhookSubscribed: true,
    wabaWebhookSubscribedAt: new Date(),
  }, { where: { companyId } })
}

async function createApprovedTemplate(companyId, wabaId, extras = {}) {
  const { WhatsAppTemplate } = getModels()
  return WhatsAppTemplate.create({
    id: uuidv4(),
    companyId,
    wabaId,
    name: extras.name || 'agent_assign_notice',
    language: extras.language || 'en_US',
    category: 'UTILITY',
    status: messages.whatsappApprovedTemplateStatus,
    components: [],
    bodyVariableKeys: extras.bodyVariableKeys || ['agentName'],
    isEnabled: true,
    lastSyncedAt: new Date(),
  })
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
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

test('registration requires auth, permission, PIN validation, and never persists PIN', async () => {
  const admin = await registerVerifiedAdmin('WaReg')
  const agent = await inviteAgent(admin)
  await connectCompany(admin)

  const unauth = await request(app).post('/api/whatsapp/register').send({ pin: '123456' })
  assert.equal(unauth.status, 401)

  const forbidden = await request(app)
    .post('/api/whatsapp/register')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ pin: '123456' })
  assert.equal(forbidden.status, 403)

  const badPin = await request(app)
    .post('/api/whatsapp/register')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pin: '12ab56' })
  assert.equal(badPin.status, 400)

  waCloud.setWhatsAppFetchImpl(async (input, init) => {
    const url = String(input)
    const method = String(init?.method || 'GET').toUpperCase()
    if (url.includes('/register')) {
      const body = JSON.parse(init.body)
      assert.equal(body.messaging_product, 'whatsapp')
      assert.equal(body.pin, '654321')
      assert.match(init.headers.Authorization, /^Bearer /)
      return jsonResponse({ success: true })
    }
    if (url.includes('/subscribed_apps') && method === 'POST') {
      return jsonResponse({ success: true })
    }
    if (url.includes('/subscribed_apps') && method === 'GET') {
      return jsonResponse({ data: [{ id: 'wa-app-111' }] })
    }
    throw new Error(`Unexpected URL ${url}`)
  })

  const registered = await request(app)
    .post('/api/whatsapp/register')
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Request-Id', 'wa-reg-1')
    .send({ pin: '654321' })
  assert.equal(registered.status, 200)
  assert.equal(registered.body.data.config.phoneRegistrationStatus, 'registered')
  assert.equal(registered.body.data.config.messagingReady, true)
  assert.equal(JSON.stringify(registered.body).includes('654321'), false)

  const { WhatsAppCompanyConfig, WhatsAppAuditLog } = getModels()
  const row = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.equal(JSON.stringify(row.toJSON()).includes('654321'), false)
  assert.equal(row.phoneRegistrationStatus, whatsappPhoneRegistrationStatuses.registered)
  assert.equal(row.wabaWebhookSubscribed, true)

  const audits = await WhatsAppAuditLog.findAll({
    where: { companyId: admin.companyId, action: whatsappAuditActions.phoneRegister },
  })
  assert.ok(audits.some((item) => item.outcome === 'success'))
  assert.equal(JSON.stringify(audits).includes('654321'), false)
})

test('registration status endpoint and company isolation', async () => {
  const companyA = await registerVerifiedAdmin('WaRegA')
  const companyB = await registerVerifiedAdmin('WaRegB')
  await connectCompany(companyA)
  await markRegistered(companyA.companyId)

  const statusA = await request(app)
    .get('/api/whatsapp/registration-status')
    .set('Authorization', `Bearer ${companyA.token}`)
  assert.equal(statusA.status, 200)
  assert.equal(statusA.body.data.registration.status, 'registered')
  assert.equal(statusA.body.data.registration.messagingReady, true)

  const statusB = await request(app)
    .get('/api/whatsapp/registration-status')
    .set('Authorization', `Bearer ${companyB.token}`)
  assert.equal(statusB.status, 200)
  assert.equal(statusB.body.data.config.connected, false)
  assert.equal(statusB.body.data.registration.status, 'unregistered')
})

test('enqueue requires approved template, registered phone, and enforces idempotency', async () => {
  const admin = await registerVerifiedAdmin('WaEnqueue')
  const { wabaId } = await connectCompany(admin)
  await markRegistered(admin.companyId)
  const template = await createApprovedTemplate(admin.companyId, wabaId)

  const missingTemplate = await request(app)
    .post('/api/whatsapp/messages')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      recipientPhone: '+15551234567',
      templateName: 'does_not_exist',
      language: 'en_US',
      parameters: ['Agent'],
      idempotencyKey: `idem-${uuidv4()}`,
    })
  assert.equal(missingTemplate.status, 400)

  const badParams = await request(app)
    .post('/api/whatsapp/messages')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      recipientPhone: '+15551234567',
      templateId: template.id,
      parameters: ['one', 'two'],
      idempotencyKey: `idem-${uuidv4()}`,
    })
  assert.equal(badParams.status, 400)

  const key = `idem-${uuidv4()}`
  const queued = await request(app)
    .post('/api/whatsapp/messages')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      recipientPhone: '+15551234567',
      templateId: template.id,
      parameters: ['Alex'],
      idempotencyKey: key,
      workflowKey: 'meta_assign',
    })
  assert.equal(queued.status, 201)
  assert.ok(queued.body.data.outboxId)

  const duplicate = await request(app)
    .post('/api/whatsapp/messages')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      recipientPhone: '+15551234567',
      templateId: template.id,
      parameters: ['Alex'],
      idempotencyKey: key,
    })
  assert.equal(duplicate.status, 409)
})

test('outbox claim, send success, concurrent lock token protection, and ambiguous timeout', async () => {
  const admin = await registerVerifiedAdmin('WaWorker')
  const { wabaId } = await connectCompany(admin)
  await markRegistered(admin.companyId)
  await createApprovedTemplate(admin.companyId, wabaId)

  const auth = { companyId: admin.companyId, userId: admin.userId }
  const enqueued = await enqueueWhatsAppMessage(auth, {
    recipientPhone: '+15559876543',
    templateName: 'agent_assign_notice',
    language: 'en_US',
    parameters: ['Jordan'],
    idempotencyKey: `worker-${uuidv4()}`,
  })

  waCloud.setWhatsAppFetchImpl(async (input) => {
    const url = String(input)
    assert.match(url, /\/messages$/)
    assert.match(url, /v27\.0/)
    return jsonResponse({
      messages: [{ id: 'wamid.TEST_MESSAGE_1' }],
    })
  })

  // Scope claim to this company + outbox id so leftover queued rows (or a shared DB)
  // cannot starve the assertion. Production worker still claims without filters.
  const claimed = await claimOutboxJobs(5, {
    companyId: admin.companyId,
    outboxId: enqueued.outboxId,
  })
  assert.equal(claimed.length, 1)
  const job = claimed[0]
  assert.ok(job)
  assert.equal(job.id, enqueued.outboxId)
  assert.equal(job.status, whatsappOutboxStatuses.processing)
  assert.ok(job.lockToken)

  await processOutboxJob(job)
  const { WhatsAppOutbox, WhatsAppMessageLog } = getModels()
  const sent = await WhatsAppOutbox.findByPk(enqueued.outboxId)
  assert.equal(sent.status, whatsappOutboxStatuses.sent)
  assert.equal(sent.providerMessageId, 'wamid.TEST_MESSAGE_1')
  assert.equal(sent.lockToken, null)

  const log = await WhatsAppMessageLog.findByPk(enqueued.messageLogId)
  assert.equal(log.status, whatsappMessageStatuses.sent)
  assert.equal(log.providerMessageId, 'wamid.TEST_MESSAGE_1')

  // Stale worker cannot overwrite with failure after success (lock token mismatch).
  job.lockToken = 'stale-token'
  const stale = await finalizeOutboxFailure(job, new AppError('stale', 500), { permanent: true })
  assert.equal(stale, false)
  const stillSent = await WhatsAppOutbox.findByPk(enqueued.outboxId)
  assert.equal(stillSent.status, whatsappOutboxStatuses.sent)

  const ambiguousEnqueue = await enqueueWhatsAppMessage(auth, {
    recipientPhone: '+15551112222',
    templateName: 'agent_assign_notice',
    language: 'en_US',
    parameters: ['Sam'],
    idempotencyKey: `amb-${uuidv4()}`,
  })
  waCloud.setWhatsAppFetchImpl(async () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  })
  const claimedAmb = await claimOutboxJobs(5, {
    companyId: admin.companyId,
    outboxId: ambiguousEnqueue.outboxId,
  })
  assert.equal(claimedAmb.length, 1)
  const ambJob = claimedAmb[0]
  assert.ok(ambJob)
  assert.equal(ambJob.id, ambiguousEnqueue.outboxId)
  await processOutboxJob(ambJob)
  const ambRow = await WhatsAppOutbox.findByPk(ambiguousEnqueue.outboxId)
  assert.equal(ambRow.status, whatsappOutboxStatuses.failed)
  assert.match(ambRow.lastError, /timed out|accepted/i)
})

test('config presents registration and messaging readiness without secrets', async () => {
  const admin = await registerVerifiedAdmin('WaCfg')
  await connectCompany(admin)
  await markRegistered(admin.companyId)
  const response = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.data.config.phoneRegistrationStatus, 'registered')
  assert.equal(response.body.data.config.messagingReady, true)
  assert.equal(JSON.stringify(response.body).includes('EAA-wa-token-secret'), false)
  assert.equal(JSON.stringify(response.body).includes('accessTokenCipher'), false)
})

test('enqueue blocked until phone is registered', async () => {
  const admin = await registerVerifiedAdmin('WaBlock')
  const { wabaId } = await connectCompany(admin)
  await createApprovedTemplate(admin.companyId, wabaId)
  const blocked = await request(app)
    .post('/api/whatsapp/messages')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      recipientPhone: '+15551234567',
      templateName: 'agent_assign_notice',
      language: 'en_US',
      parameters: ['Alex'],
      idempotencyKey: `blocked-${uuidv4()}`,
    })
  assert.equal(blocked.status, 400)
})
