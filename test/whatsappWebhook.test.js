const assert = require('node:assert/strict')
const crypto = require('node:crypto')
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
process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = '1'
process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = 'wa-config-333'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const waCloud = require('../src/services/whatsappCloudClient')
const { upsertConnectedConfigForTests } = require('../src/services/whatsappConfigService')
const {
  canAdvanceStatus,
  acceptWhatsAppWebhookPayload,
} = require('../src/services/whatsappWebhookService')
const {
  whatsappMessageStatuses,
  whatsappOutboxStatuses,
  whatsappPhoneRegistrationStatuses,
} = require('../src/utils/enums')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

function signBody(raw, secret = process.env.WHATSAPP_APP_SECRET) {
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  return `sha256=${digest}`
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

async function registerVerifiedAdmin(prefix = 'WaHook') {
  clearMemoryOutbox()
  const email = `wa.hook.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName: uniqueName(prefix),
    adminName: 'WA Hook Admin',
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

async function connectRegisteredCompany(admin, overrides = {}) {
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
  const { WhatsAppCompanyConfig } = getModels()
  await WhatsAppCompanyConfig.update({
    phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.registered,
    phoneRegisteredAt: new Date(),
    wabaWebhookSubscribed: Boolean(overrides.subscribed),
    wabaWebhookSubscribedAt: overrides.subscribed ? new Date() : null,
  }, { where: { companyId: admin.companyId } })
  return { wabaId, phoneNumberId }
}

async function seedMessageLog(companyId, {
  providerMessageId,
  status = whatsappMessageStatuses.queued,
  outboxStatus = whatsappOutboxStatuses.queued,
}) {
  const { WhatsAppMessageLog, WhatsAppOutbox } = getModels()
  const logId = uuidv4()
  const outboxId = uuidv4()
  const idempotencyKey = `idem-${uuidv4()}`
  await WhatsAppMessageLog.create({
    id: logId,
    companyId,
    outboxId,
    recipientPhone: '+15551234567',
    recipientType: 'customer',
    templateId: null,
    templateName: 'agent_assign_notice',
    language: 'en_US',
    workflowKey: 'manual',
    status,
    providerMessageId,
    idempotencyKey,
    lastError: '',
    statusEvents: [],
  })
  await WhatsAppOutbox.create({
    id: outboxId,
    companyId,
    messageLogId: logId,
    recipientPhone: '+15551234567',
    recipientType: 'customer',
    templateName: 'agent_assign_notice',
    language: 'en_US',
    templateParameters: [],
    status: outboxStatus,
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
    idempotencyKey,
    lastError: '',
    providerMessageId: providerMessageId || null,
    workflowKey: 'manual',
  })
  return { logId, outboxId }
}

function statusPayload({ wabaId, phoneNumberId, statuses }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: wabaId,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15550100',
            phone_number_id: phoneNumberId,
          },
          statuses,
        },
      }],
    }],
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
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'wa-verify-token'
  process.env.WHATSAPP_APP_SECRET = 'wa-app-secret-222'
  process.env.WHATSAPP_APP_ID = 'wa-app-111'
})

test('GET webhook verification accepts correct token and rejects invalid or missing config', async () => {
  const ok = await request(app).get('/api/whatsapp/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wa-verify-token',
    'hub.challenge': 'challenge-wa-123',
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.text, 'challenge-wa-123')

  const bad = await request(app).get('/api/whatsapp/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong-token',
    'hub.challenge': 'challenge-wa-123',
  })
  assert.equal(bad.status, 403)

  const previous = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = ''
  const missing = await request(app).get('/api/whatsapp/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wa-verify-token',
    'hub.challenge': 'challenge-wa-123',
  })
  assert.equal(missing.status, 403)
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = previous
})

test('POST webhook signature validates raw body; modified body and invalid signatures are rejected', async () => {
  const admin = await registerVerifiedAdmin('WaSig')
  const { wabaId, phoneNumberId } = await connectRegisteredCompany(admin, { subscribed: true })
  await seedMessageLog(admin.companyId, { providerMessageId: 'wamid.sig-1' })

  const payload = statusPayload({
    wabaId,
    phoneNumberId,
    statuses: [{
      id: 'wamid.sig-1',
      status: 'sent',
      timestamp: '1700000001',
      recipient_id: '15551234567',
    }],
  })
  const rawText = JSON.stringify(payload)

  const missingSig = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .send(rawText)
  assert.equal(missingSig.status, 401)

  const badSig = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', 'sha256=deadbeef')
    .send(rawText)
  assert.equal(badSig.status, 401)

  const modified = `${rawText.slice(0, -1)} `
  const tampered = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(Buffer.from(rawText)))
    .send(modified)
  assert.equal(tampered.status, 401)

  const ok = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(Buffer.from(rawText)))
    .send(rawText)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.data.ok, true)
  assert.equal(JSON.stringify(ok.body).includes('EAA-wa-token-secret'), false)
})

test('status transitions, out-of-order events, and duplicate history prevention', async () => {
  const admin = await registerVerifiedAdmin('WaStatus')
  const { wabaId, phoneNumberId } = await connectRegisteredCompany(admin, { subscribed: true })
  const { logId, outboxId } = await seedMessageLog(admin.companyId, {
    providerMessageId: 'wamid.status-1',
  })
  const { WhatsAppMessageLog, WhatsAppOutbox, WhatsAppWebhookEvent, WhatsAppCompanyConfig } = getModels()

  async function postStatus(status, timestamp) {
    const payload = statusPayload({
      wabaId,
      phoneNumberId,
      statuses: [{
        id: 'wamid.status-1',
        status,
        timestamp,
        recipient_id: '15551234567',
        ...(status === 'failed' ? {
          errors: [{ code: 131026, title: 'Message undeliverable' }],
        } : {}),
      }],
    })
    const rawText = JSON.stringify(payload)
    const response = await request(app)
      .post('/api/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(Buffer.from(rawText)))
      .send(rawText)
    assert.equal(response.status, 200)
    return response
  }

  await postStatus('sent', '100')
  let log = await WhatsAppMessageLog.findByPk(logId)
  let outbox = await WhatsAppOutbox.findByPk(outboxId)
  assert.equal(log.status, whatsappMessageStatuses.sent)
  assert.equal(outbox.status, whatsappOutboxStatuses.sent)
  assert.equal(log.statusEvents.length, 1)

  await postStatus('delivered', '200')
  log = await WhatsAppMessageLog.findByPk(logId)
  assert.equal(log.status, whatsappMessageStatuses.delivered)
  assert.equal(log.statusEvents.length, 2)

  await postStatus('read', '300')
  log = await WhatsAppMessageLog.findByPk(logId)
  assert.equal(log.status, whatsappMessageStatuses.read)
  assert.equal(log.statusEvents.length, 3)

  // Duplicate identical event — history must not grow.
  await postStatus('read', '300')
  log = await WhatsAppMessageLog.findByPk(logId)
  assert.equal(log.status, whatsappMessageStatuses.read)
  assert.equal(log.statusEvents.length, 3)

  // Out-of-order older delivered must not downgrade read.
  await postStatus('delivered', '150')
  log = await WhatsAppMessageLog.findByPk(logId)
  assert.equal(log.status, whatsappMessageStatuses.read)
  assert.equal(log.statusEvents.length, 4)

  // Fresh message for failed path
  const failed = await seedMessageLog(admin.companyId, {
    providerMessageId: 'wamid.status-fail',
  })
  const failPayload = statusPayload({
    wabaId,
    phoneNumberId,
    statuses: [{
      id: 'wamid.status-fail',
      status: 'failed',
      timestamp: '400',
      recipient_id: '15551234567',
      errors: [{ code: 131026, title: 'Message undeliverable' }],
    }],
  })
  const failText = JSON.stringify(failPayload)
  await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(Buffer.from(failText)))
    .send(failText)
  const failedLog = await WhatsAppMessageLog.findByPk(failed.logId)
  assert.equal(failedLog.status, whatsappMessageStatuses.failed)
  assert.match(failedLog.lastError, /131026/)
  assert.equal(JSON.stringify(failedLog.statusEvents).includes('Message undeliverable'), true)

  const config = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.ok(config.webhookLastEventAt)
  assert.equal(config.webhookLastError, '')

  const events = await WhatsAppWebhookEvent.findAll({
    where: { companyId: admin.companyId, providerMessageId: 'wamid.status-1' },
  })
  assert.ok(events.length >= 4)
})

test('duplicate webhook payloads are idempotent; unknown message ids and malformed payloads are safe', async () => {
  const admin = await registerVerifiedAdmin('WaDup')
  const { wabaId, phoneNumberId } = await connectRegisteredCompany(admin, { subscribed: true })
  await seedMessageLog(admin.companyId, { providerMessageId: 'wamid.dup-1' })
  const { WhatsAppWebhookEvent, WhatsAppMessageLog } = getModels()

  const payload = statusPayload({
    wabaId,
    phoneNumberId,
    statuses: [{
      id: 'wamid.dup-1',
      status: 'sent',
      timestamp: '500',
      recipient_id: '15551234567',
    }],
  })
  const rawText = JSON.stringify(payload)
  const sig = signBody(Buffer.from(rawText))

  const first = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .send(rawText)
  assert.equal(first.status, 200)
  assert.equal(first.body.data.processed, 1)

  const second = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .send(rawText)
  assert.equal(second.status, 200)
  assert.equal(second.body.data.duplicates >= 1, true)

  const rows = await WhatsAppWebhookEvent.findAll({
    where: { companyId: admin.companyId, providerMessageId: 'wamid.dup-1' },
  })
  assert.equal(rows.length, 1)

  const unknownPayload = statusPayload({
    wabaId,
    phoneNumberId,
    statuses: [{
      id: 'wamid.unknown-xyz',
      status: 'delivered',
      timestamp: '600',
      recipient_id: '15551234567',
    }],
  })
  const unknownText = JSON.stringify(unknownPayload)
  const unknown = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(Buffer.from(unknownText)))
    .send(unknownText)
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.data.ignored >= 1, true)
  const unknownLog = await WhatsAppMessageLog.findOne({
    where: { companyId: admin.companyId, providerMessageId: 'wamid.unknown-xyz' },
  })
  assert.equal(unknownLog, null)

  const malformed = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(Buffer.from('{not-json')))
    .send('{not-json')
  assert.equal(malformed.status, 400)

  const unsupported = {
    object: 'whatsapp_business_account',
    entry: [{
      id: wabaId,
      changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }],
    }],
  }
  const unsupportedText = JSON.stringify(unsupported)
  const unsupportedRes = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(Buffer.from(unsupportedText)))
    .send(unsupportedText)
  assert.equal(unsupportedRes.status, 200)
})

test('routes status events to the correct company; never trusts payload company ids', async () => {
  const companyA = await registerVerifiedAdmin('WaCoA')
  const companyB = await registerVerifiedAdmin('WaCoB')
  const a = await connectRegisteredCompany(companyA, {
    wabaId: `waba-a-${uuidv4().slice(0, 6)}`,
    phoneNumberId: `phone-a-${uuidv4().slice(0, 6)}`,
    subscribed: true,
  })
  const b = await connectRegisteredCompany(companyB, {
    wabaId: `waba-b-${uuidv4().slice(0, 6)}`,
    phoneNumberId: `phone-b-${uuidv4().slice(0, 6)}`,
    subscribed: true,
  })
  const wamidA = `wamid.a-${uuidv4().slice(0, 8)}`
  const wamidB = `wamid.b-${uuidv4().slice(0, 8)}`
  await seedMessageLog(companyA.companyId, { providerMessageId: wamidA })
  await seedMessageLog(companyB.companyId, { providerMessageId: wamidB })

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: a.wabaId,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: a.phoneNumberId },
          statuses: [{
            id: wamidA,
            status: 'sent',
            timestamp: '700',
            recipient_id: '15550001111',
          }],
        },
      }],
    }],
  }
  // Extra property must be ignored for tenant resolution.
  payload.companyId = companyB.companyId
  const rawText = JSON.stringify(payload)
  const res = await request(app)
    .post('/api/whatsapp/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(Buffer.from(rawText)))
    .send(rawText)
  assert.equal(res.status, 200)

  const { WhatsAppMessageLog, WhatsAppWebhookEvent } = getModels()
  const logA = await WhatsAppMessageLog.findOne({
    where: { companyId: companyA.companyId, providerMessageId: wamidA },
  })
  const logB = await WhatsAppMessageLog.findOne({
    where: { companyId: companyB.companyId, providerMessageId: wamidB },
  })
  assert.equal(logA.status, whatsappMessageStatuses.sent)
  assert.equal(logB.status, whatsappMessageStatuses.queued)

  const event = await WhatsAppWebhookEvent.findOne({
    where: {
      companyId: companyA.companyId,
      providerMessageId: wamidA,
    },
  })
  assert.ok(event)
  assert.equal(event.companyId, companyA.companyId)
  assert.notEqual(event.companyId, companyB.companyId)
  assert.ok(b.wabaId)
})

test('config presenter exposes webhook health without secrets; subscription retry verifies via GET', async () => {
  const admin = await registerVerifiedAdmin('WaSub')
  await connectRegisteredCompany(admin, { subscribed: false })

  const config = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(config.status, 200)
  assert.equal(config.body.data.config.webhookConfigured, true)
  assert.equal(config.body.data.config.wabaWebhookSubscribed, false)
  assert.equal(Object.prototype.hasOwnProperty.call(config.body.data.config, 'webhookLastEventAt'), true)
  assert.equal(JSON.stringify(config.body).includes('wa-app-secret-222'), false)
  assert.equal(JSON.stringify(config.body).includes('wa-verify-token'), false)

  waCloud.setWhatsAppFetchImpl(async (input, init) => {
    const url = String(input)
    const method = String(init?.method || 'GET').toUpperCase()
    if (url.includes('/subscribed_apps') && method === 'POST') {
      return jsonResponse({ success: true })
    }
    if (url.includes('/subscribed_apps') && method === 'GET') {
      return jsonResponse({ data: [{ id: 'wa-app-111' }] })
    }
    throw new Error(`Unexpected URL ${url}`)
  })

  const subscribed = await request(app)
    .post('/api/whatsapp/webhook-subscription')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(subscribed.status, 200)
  assert.equal(subscribed.body.data.config.wabaWebhookSubscribed, true)

  waCloud.setWhatsAppFetchImpl(async (input, init) => {
    const url = String(input)
    const method = String(init?.method || 'GET').toUpperCase()
    if (url.includes('/subscribed_apps') && method === 'POST') {
      return jsonResponse({ success: true })
    }
    if (url.includes('/subscribed_apps') && method === 'GET') {
      return jsonResponse({ data: [{ id: 'other-app' }] })
    }
    throw new Error(`Unexpected URL ${url}`)
  })

  const failed = await request(app)
    .post('/api/whatsapp/webhook-subscription')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(failed.status, 502)

  const { WhatsAppCompanyConfig } = getModels()
  const row = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.equal(row.wabaWebhookSubscribed, false)
})

test('canAdvanceStatus enforces monotonic delivery ranks and terminal failed', () => {
  assert.equal(canAdvanceStatus('queued', 'sent'), true)
  assert.equal(canAdvanceStatus('sent', 'delivered'), true)
  assert.equal(canAdvanceStatus('delivered', 'read'), true)
  assert.equal(canAdvanceStatus('read', 'delivered'), false)
  assert.equal(canAdvanceStatus('sent', 'failed'), true)
  assert.equal(canAdvanceStatus('failed', 'delivered'), false)
  assert.equal(canAdvanceStatus('read', 'failed'), false)
})

test('direct acceptWhatsAppWebhookPayload handles empty/malformed object without throwing', async () => {
  const result = await acceptWhatsAppWebhookPayload({ object: 'page', entry: [] }, Buffer.from('{}'))
  assert.equal(result.ignored, 1)
  assert.equal(result.processed, 0)
})
