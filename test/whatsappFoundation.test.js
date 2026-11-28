const {
  isolatedTestDbConfigured,
  applyIsolatedTestDbEnv,
  assertIsolatedTestDbOrThrow,
} = require('./helpers/isolatedTestDb')
assertIsolatedTestDbOrThrow()
applyIsolatedTestDbEnv()

const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = 'http://localhost:5174'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex')
process.env.WHATSAPP_MANUAL_TOKEN_ENABLED = '1'

const { app } = require('../src/server')
const { listPermissions, isKnownPermission } = require('../src/config/permissions')
const { adminUserPermissions } = require('../src/config/seed')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { sanitizeAuditDetail } = require('../src/services/whatsappAuditService')
const {
  assertManualTokenAllowed,
  isManualTokenAllowed,
  presentWhatsAppConfig,
  readDecryptedAccessToken,
  upsertConnectedConfigForTests,
} = require('../src/services/whatsappConfigService')
const {
  SIGNUP_TTL_MS,
  consumeEmbeddedSignupSession,
  createEmbeddedSignupSession,
  hashNonce,
} = require('../src/services/whatsappEmbeddedSignupSessionService')
const {
  permissionKeys,
  roleKeys,
  whatsappAuditActions,
  whatsappEmbeddedSignupStatuses,
  whatsappOutboxStatuses,
  whatsappTemplateVariableKeys,
} = require('../src/utils/enums')
const { encryptSecret, decryptSecret } = require('../src/utils/metaSecrets')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'Wa') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `wa.admin.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'WhatsApp Admin',
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
    email,
    permissions: login.body.data.user.role.permissions,
  }
}

async function inviteAgentWithoutWhatsApp(admin) {
  const roles = await request(app)
    .get('/api/roles')
    .set('Authorization', `Bearer ${admin.token}`)
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  assert.ok(agentRole)
  assert.equal(agentRole.permissions.includes(permissionKeys.whatsappManage), false)

  const email = `wa.agent.${Date.now()}@example.com`
  const invite = await request(app)
    .post('/api/invitations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      name: 'WA Agent',
      email,
      roleId: agentRole.id,
    })
  assert.equal(invite.status, 201)
  const inviteToken = new URL(invite.body.data.link).searchParams.get('token')
  const accept = await request(app).post('/api/invitations/accept').send({
    token: inviteToken,
    password: 'Password2!',
    confirmPassword: 'Password2!',
  })
  assert.equal(accept.status, 200)
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password2!',
  })
  assert.equal(login.status, 200)
  return {
    token: login.body.data.accessToken,
    companyId: login.body.data.user.company.id,
    userId: login.body.data.user.id,
  }
}

async function createQueuedOutbox(companyId, suffix) {
  const { WhatsAppMessageLog, WhatsAppOutbox } = getModels()
  const messageLogId = uuidv4()
  const outboxId = uuidv4()
  const idempotencyKey = `wa-test-${suffix}-${uuidv4()}`
  await WhatsAppMessageLog.create({
    id: messageLogId,
    companyId,
    outboxId,
    recipientPhone: '+15551234567',
    recipientType: 'agent',
    templateName: 'test_template',
    language: 'en',
    workflowKey: 'meta_assign',
    status: 'queued',
    idempotencyKey,
    statusEvents: [],
  })
  await WhatsAppOutbox.create({
    id: outboxId,
    companyId,
    messageLogId,
    recipientPhone: '+15551234567',
    recipientType: 'agent',
    templateName: 'test_template',
    language: 'en',
    templateParameters: [],
    status: whatsappOutboxStatuses.queued,
    nextAttemptAt: new Date(),
    idempotencyKey,
    workflowKey: 'meta_assign',
  })
  return { messageLogId, outboxId, idempotencyKey }
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('permission registry includes WhatsApp keys; agent seed excludes them', () => {
  assert.equal(isKnownPermission(permissionKeys.whatsappManage), true)
  assert.equal(isKnownPermission(permissionKeys.whatsappViewLogs), true)
  const keys = listPermissions().map((row) => row.key)
  assert.ok(keys.includes(permissionKeys.whatsappManage))
  assert.ok(keys.includes(permissionKeys.whatsappViewLogs))
  assert.ok(adminUserPermissions.includes(permissionKeys.whatsappManage))
  assert.ok(adminUserPermissions.includes(permissionKeys.whatsappViewLogs))
  assert.ok(whatsappTemplateVariableKeys.includes('leadName'))
  assert.ok(whatsappTemplateVariableKeys.includes('agentPhone'))
})

test('Meta encryption helpers remain unchanged for Lead Ads tokens', () => {
  const stored = encryptSecret('plain-meta-secret')
  assert.equal(decryptSecret(stored), 'plain-meta-secret')
  assert.equal(stored.keyVersion, 1)
})

test('GET config returns disconnected shape and never leaks secrets', async () => {
  const admin = await registerVerifiedAdmin('WaGet')
  assert.ok(admin.permissions.includes(permissionKeys.whatsappManage))

  const response = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(response.status, 200)
  const config = response.body.data.config
  assert.equal(config.connected, false)
  assert.equal(config.tokenStored, false)
  const raw = JSON.stringify(response.body)
  assert.equal(raw.includes('accessToken'), false)
  assert.equal(raw.includes('Cipher'), false)
  assert.equal(raw.includes('cipher'), false)
  assert.equal(raw.includes('plain'), false)
})

test('permission enforcement blocks unauthenticated and agent callers', async () => {
  const admin = await registerVerifiedAdmin('WaPerm')
  const agent = await inviteAgentWithoutWhatsApp(admin)

  const unauth = await request(app).get('/api/whatsapp/config')
  assert.equal(unauth.status, 401)

  const forbiddenGet = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${agent.token}`)
  assert.equal(forbiddenGet.status, 403)

  const forbiddenPatch = await request(app)
    .patch('/api/whatsapp/config')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ metaAssignEnabled: true })
  assert.equal(forbiddenPatch.status, 403)

  const forbiddenDisconnect = await request(app)
    .post('/api/whatsapp/disconnect')
    .set('Authorization', `Bearer ${agent.token}`)
  assert.equal(forbiddenDisconnect.status, 403)
})

test('company isolation: config and uniqueness are tenant-scoped', async () => {
  const companyA = await registerVerifiedAdmin('WaIsoA')
  const companyB = await registerVerifiedAdmin('WaIsoB')
  const wabaId = `waba-${uuidv4().slice(0, 8)}`
  const phoneNumberId = `phone-${uuidv4().slice(0, 8)}`

  await upsertConnectedConfigForTests({
    companyId: companyA.companyId,
    userId: companyA.userId,
  }, {
    wabaId,
    phoneNumberId,
    accessToken: 'token-company-a-secret',
    displayPhoneNumber: '+15550001111',
  })

  const getA = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${companyA.token}`)
  assert.equal(getA.status, 200)
  assert.equal(getA.body.data.config.connected, true)
  assert.equal(getA.body.data.config.wabaId, wabaId)
  assert.equal(JSON.stringify(getA.body).includes('token-company-a-secret'), false)

  const getB = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${companyB.token}`)
  assert.equal(getB.status, 200)
  assert.equal(getB.body.data.config.connected, false)
  assert.equal(getB.body.data.config.wabaId, null)

  await assert.rejects(
    () => upsertConnectedConfigForTests({
      companyId: companyB.companyId,
      userId: companyB.userId,
    }, {
      wabaId,
      phoneNumberId: `other-phone-${uuidv4().slice(0, 8)}`,
      accessToken: 'token-b',
    }),
    (error) => error.statusCode === 409,
  )

  await assert.rejects(
    () => upsertConnectedConfigForTests({
      companyId: companyB.companyId,
      userId: companyB.userId,
    }, {
      wabaId: `other-waba-${uuidv4().slice(0, 8)}`,
      phoneNumberId,
      accessToken: 'token-b',
    }),
    (error) => error.statusCode === 409,
  )
})

test('PATCH validates body, updates toggles, and writes sanitized audit', async () => {
  const admin = await registerVerifiedAdmin('WaPatch')
  await upsertConnectedConfigForTests({
    companyId: admin.companyId,
    userId: admin.userId,
  }, {
    wabaId: `waba-patch-${uuidv4().slice(0, 8)}`,
    phoneNumberId: `phone-patch-${uuidv4().slice(0, 8)}`,
    accessToken: 'patch-token-secret',
  })

  const empty = await request(app)
    .patch('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Request-Id', 'wa-patch-req-1')
    .send({})
  assert.equal(empty.status, 400)

  const badBool = await request(app)
    .patch('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ metaAssignEnabled: 'yes' })
  assert.equal(badBool.status, 400)

  const badLang = await request(app)
    .patch('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ defaultLanguage: '!!!' })
  assert.equal(badLang.status, 400)

  const updated = await request(app)
    .patch('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Request-Id', 'wa-patch-req-1')
    .send({
      metaAssignEnabled: true,
      transferEnabled: true,
      defaultLanguage: 'en_US',
    })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.data.config.metaAssignEnabled, true)
  assert.equal(updated.body.data.config.transferEnabled, true)
  assert.equal(updated.body.data.config.defaultLanguage, 'en_US')
  assert.equal(JSON.stringify(updated.body).includes('accessToken'), false)

  const { WhatsAppAuditLog, WhatsAppCompanyConfig } = getModels()
  const audits = await WhatsAppAuditLog.findAll({
    where: { companyId: admin.companyId, action: whatsappAuditActions.configUpdate },
    order: [['createdAt', 'DESC']],
  })
  assert.ok(audits.length >= 1)
  assert.equal(audits[0].requestId, 'wa-patch-req-1')
  assert.equal(audits[0].detail.includes('Bearer'), false)
  assert.equal(audits[0].detail.includes('patch-token-secret'), false)

  const row = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.ok(row.accessTokenCipher)
  assert.equal(readDecryptedAccessToken(row), 'patch-token-secret')
  const presented = presentWhatsAppConfig(row)
  assert.equal(Object.prototype.hasOwnProperty.call(presented, 'accessTokenCipher'), false)
})

test('disconnect cancels outbox, releases identifiers, preserves audit history', async () => {
  const admin = await registerVerifiedAdmin('WaDisc')
  const wabaId = `waba-disc-${uuidv4().slice(0, 8)}`
  const phoneNumberId = `phone-disc-${uuidv4().slice(0, 8)}`
  await upsertConnectedConfigForTests({
    companyId: admin.companyId,
    userId: admin.userId,
  }, {
    wabaId,
    phoneNumberId,
    accessToken: 'disconnect-token-secret',
  })
  const { outboxId } = await createQueuedOutbox(admin.companyId, 'disc')

  const disconnected = await request(app)
    .post('/api/whatsapp/disconnect')
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Request-Id', 'wa-disc-req-1')
  assert.equal(disconnected.status, 200)
  assert.equal(disconnected.body.data.config.connected, false)
  assert.equal(disconnected.body.data.config.wabaId, null)
  assert.equal(disconnected.body.data.config.phoneNumberId, null)
  assert.equal(disconnected.body.data.config.tokenStored, false)
  assert.equal(JSON.stringify(disconnected.body).includes('disconnect-token-secret'), false)

  const { WhatsAppCompanyConfig, WhatsAppOutbox, WhatsAppAuditLog } = getModels()
  const row = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.equal(row.isActive, false)
  assert.equal(row.wabaId, null)
  assert.equal(row.phoneNumberId, null)
  assert.equal(row.accessTokenCipher, null)
  assert.equal(row.tokenStored, false)

  const outbox = await WhatsAppOutbox.findByPk(outboxId)
  assert.equal(outbox.status, whatsappOutboxStatuses.cancelled)

  const audits = await WhatsAppAuditLog.findAll({
    where: { companyId: admin.companyId, action: whatsappAuditActions.disconnect },
  })
  assert.ok(audits.length >= 1)
  assert.equal(audits[0].requestId, 'wa-disc-req-1')
  assert.equal(audits[0].detail.includes('disconnect-token-secret'), false)

  const other = await registerVerifiedAdmin('WaReuse')
  await upsertConnectedConfigForTests({
    companyId: other.companyId,
    userId: other.userId,
  }, {
    wabaId,
    phoneNumberId,
    accessToken: 'reuse-after-disconnect',
  })
  const reused = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${other.token}`)
  assert.equal(reused.status, 200)
  assert.equal(reused.body.data.config.wabaId, wabaId)
})

test('audit sanitization redacts tokens and ciphertext', () => {
  const detail = sanitizeAuditDetail(
    'Bearer abc.def.ghi accessToken=super-secret cipherText=AAAA authorization_code=xyz',
  )
  assert.equal(detail.includes('abc.def.ghi'), false)
  assert.equal(detail.includes('super-secret'), false)
  assert.equal(detail.includes('AAAA'), false)
  assert.equal(detail.includes('xyz'), false)
  assert.match(detail, /\[redacted\]/)
})

test('embedded signup session: hashed nonce, expiry, and single-use consume', async () => {
  const admin = await registerVerifiedAdmin('WaNonce')
  const auth = { companyId: admin.companyId, userId: admin.userId }
  const created = await createEmbeddedSignupSession(auth, {
    ip: '127.0.0.1',
    requestId: 'wa-nonce-1',
  })
  assert.ok(created.sessionId)
  assert.ok(created.nonce)
  assert.ok(created.expiresAt instanceof Date)
  assert.ok(created.expiresAt.getTime() - Date.now() <= SIGNUP_TTL_MS)
  assert.ok(created.expiresAt.getTime() - Date.now() > SIGNUP_TTL_MS - 60_000)

  const { WhatsAppEmbeddedSignupSession } = getModels()
  const row = await WhatsAppEmbeddedSignupSession.findByPk(created.sessionId)
  assert.equal(row.nonceHash, hashNonce(created.nonce))
  assert.notEqual(row.nonceHash, created.nonce)
  assert.equal(row.status, whatsappEmbeddedSignupStatuses.pending)

  const consumed = await consumeEmbeddedSignupSession(auth, created.nonce)
  assert.equal(consumed.status, whatsappEmbeddedSignupStatuses.consumed)
  assert.ok(consumed.consumedAt)

  await assert.rejects(
    () => consumeEmbeddedSignupSession(auth, created.nonce),
    (error) => error.statusCode === 400,
  )

  const expired = await createEmbeddedSignupSession(auth)
  await WhatsAppEmbeddedSignupSession.update({
    expiresAt: new Date(Date.now() - 1000),
  }, { where: { id: expired.sessionId } })
  await assert.rejects(
    () => consumeEmbeddedSignupSession(auth, expired.nonce),
    (error) => error.statusCode === 400,
  )

  const other = await registerVerifiedAdmin('WaNonceOther')
  const foreign = await createEmbeddedSignupSession({
    companyId: other.companyId,
    userId: other.userId,
  })
  await assert.rejects(
    () => consumeEmbeddedSignupSession(auth, foreign.nonce),
    (error) => error.statusCode === 400,
  )
})

test('manual token helper is forbidden in production unless explicitly enabled', () => {
  assert.equal(isManualTokenAllowed(), true)
  const previousEnv = process.env.NODE_ENV
  const previousFlag = process.env.WHATSAPP_MANUAL_TOKEN_ENABLED
  process.env.NODE_ENV = 'production'
  process.env.WHATSAPP_MANUAL_TOKEN_ENABLED = '0'
  try {
    assert.equal(isManualTokenAllowed(), false)
    assert.throws(() => assertManualTokenAllowed(), (error) => error.statusCode === 403)
    process.env.WHATSAPP_MANUAL_TOKEN_ENABLED = '1'
    assert.equal(isManualTokenAllowed(), true)
  } finally {
    process.env.NODE_ENV = previousEnv
    process.env.WHATSAPP_MANUAL_TOKEN_ENABLED = previousFlag
  }
})
