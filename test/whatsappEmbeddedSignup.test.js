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
process.env.APP_BASE_URL = 'http://localhost:5174'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex')
process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = '1'
process.env.WHATSAPP_APP_ID = 'wa-app-111'
process.env.WHATSAPP_APP_SECRET = 'wa-app-secret-222'
process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = 'wa-config-333'
process.env.WHATSAPP_GRAPH_API_VERSION = 'v27.0'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const graphClient = require('../src/services/metaGraph')
const { permissionKeys, roleKeys, whatsappAuditActions, whatsappTokenSources } = require('../src/utils/enums')
const { decryptSecret } = require('../src/utils/metaSecrets')
const { upsertConnectedConfigForTests } = require('../src/services/whatsappConfigService')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'WaEs') {
  clearMemoryOutbox()
  const email = `wa.es.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName: uniqueName(prefix),
    adminName: 'WA ES Admin',
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
  const email = `wa.es.agent.${Date.now()}@example.com`
  const invite = await request(app)
    .post('/api/invitations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Agent', email, roleId: agentRole.id })
  assert.equal(invite.status, 201)
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
  assert.equal(login.status, 200)
  return { token: login.body.data.accessToken }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function installSuccessGraph({
  accessToken = 'EAA-business-token-secret',
  wabaId,
  phoneNumberId,
  scopes = ['whatsapp_business_management', 'whatsapp_business_messaging'],
  phones,
}) {
  const phoneRows = phones || [{
    id: phoneNumberId,
    display_phone_number: '+1 555 0100',
    verified_name: 'Harmoniq Test',
    quality_rating: 'GREEN',
    code_verification_status: 'VERIFIED',
    throughput: { level: 'STANDARD' },
  }]
  graphClient.setFetchImpl(async (input) => {
    const url = String(input)
    if (url.includes('/oauth/access_token')) {
      assert.equal(url.includes('redirect_uri'), false)
      assert.equal(url.includes('client_secret=wa-app-secret-222'), true)
      return jsonResponse({ access_token: accessToken, token_type: 'bearer' })
    }
    if (url.includes('/debug_token')) {
      return jsonResponse({
        data: {
          app_id: 'wa-app-111',
          is_valid: true,
          scopes,
          granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [wabaId] }],
          type: 'SYSTEM_USER',
          expires_at: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
        },
      })
    }
    if (url.includes(`/${wabaId}/phone_numbers`)) {
      return jsonResponse({ data: phoneRows })
    }
    if (url.includes(`/${wabaId}?`) || url.endsWith(`/${wabaId}`)) {
      return jsonResponse({ id: wabaId, name: 'Customer WABA' })
    }
    throw new Error(`Unexpected Graph URL: ${url}`)
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

test('start requires auth and whatsapp.manage; returns non-secret SDK config', async () => {
  const admin = await registerVerifiedAdmin('WaStart')
  const agent = await inviteAgent(admin)

  const unauth = await request(app).post('/api/whatsapp/embedded-signup/start')
  assert.equal(unauth.status, 401)

  const forbidden = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${agent.token}`)
  assert.equal(forbidden.status, 403)

  const started = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Request-Id', 'wa-start-1')
  assert.equal(started.status, 200)
  assert.ok(started.body.data.nonce)
  assert.equal(started.body.data.appId, 'wa-app-111')
  assert.equal(started.body.data.configId, 'wa-config-333')
  assert.equal(started.body.data.graphApiVersion, 'v27.0')
  assert.deepEqual(started.body.data.extras, { setup: {} })
  assert.equal(started.body.data.loginOptions.responseType, 'code')
  const raw = JSON.stringify(started.body)
  assert.equal(raw.includes('wa-app-secret-222'), false)
  assert.equal(raw.includes('appSecret'), false)

  const { WhatsAppEmbeddedSignupSession, WhatsAppAuditLog } = getModels()
  const sessions = await WhatsAppEmbeddedSignupSession.findAll({
    where: { companyId: admin.companyId, userId: admin.userId },
  })
  assert.ok(sessions.length >= 1)
  assert.notEqual(sessions.at(-1).nonceHash, started.body.data.nonce)
  const audits = await WhatsAppAuditLog.findAll({
    where: { companyId: admin.companyId, action: whatsappAuditActions.signupStart },
  })
  assert.ok(audits.length >= 1)
})

test('complete exchanges code, verifies WABA/phone, encrypts token, never leaks secrets', async () => {
  const admin = await registerVerifiedAdmin('WaComplete')
  const wabaId = `waba-${uuidv4().slice(0, 8)}`
  const phoneNumberId = `phone-${uuidv4().slice(0, 8)}`
  installSuccessGraph({ wabaId, phoneNumberId })

  const started = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(started.status, 200)

  const completed = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .set('X-Request-Id', 'wa-complete-1')
    .send({
      nonce: started.body.data.nonce,
      authorizationCode: 'AQB-auth-code-secret',
      wabaId,
      phoneNumberId,
      businessId: 'biz-555',
    })
  assert.equal(completed.status, 200)
  assert.equal(completed.body.data.config.connected, true)
  assert.equal(completed.body.data.config.wabaId, wabaId)
  assert.equal(completed.body.data.config.phoneNumberId, phoneNumberId)
  assert.equal(completed.body.data.config.displayPhoneNumber, '+1 555 0100')
  assert.equal(completed.body.data.config.tokenSource, whatsappTokenSources.embeddedSignup)
  const bodyRaw = JSON.stringify(completed.body)
  assert.equal(bodyRaw.includes('EAA-business-token-secret'), false)
  assert.equal(bodyRaw.includes('AQB-auth-code-secret'), false)
  assert.equal(bodyRaw.includes('wa-app-secret'), false)
  assert.equal(bodyRaw.includes('accessTokenCipher'), false)

  const { WhatsAppCompanyConfig, WhatsAppAuditLog } = getModels()
  const row = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.ok(row.accessTokenCipher)
  assert.ok(row.accessTokenIv)
  assert.ok(row.accessTokenTag)
  assert.equal(row.tokenSource, whatsappTokenSources.embeddedSignup)
  assert.equal(decryptSecret({
    cipherText: row.accessTokenCipher,
    iv: row.accessTokenIv,
    tag: row.accessTokenTag,
    keyVersion: row.keyVersion,
  }), 'EAA-business-token-secret')

  const audits = await WhatsAppAuditLog.findAll({
    where: { companyId: admin.companyId, action: whatsappAuditActions.connect },
  })
  assert.ok(audits.some((row) => row.outcome === 'success'))
  assert.equal(JSON.stringify(audits).includes('EAA-business-token-secret'), false)
})

test('complete rejects reused nonce and expired sessions', async () => {
  const admin = await registerVerifiedAdmin('WaReuse')
  const wabaId = `waba-${uuidv4().slice(0, 8)}`
  const phoneNumberId = `phone-${uuidv4().slice(0, 8)}`
  installSuccessGraph({ wabaId, phoneNumberId })

  const started = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
  const payload = {
    nonce: started.body.data.nonce,
    authorizationCode: 'AQB-1',
    wabaId,
    phoneNumberId,
  }
  const first = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .send(payload)
  assert.equal(first.status, 200)

  const second = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .send(payload)
  assert.equal(second.status, 400)

  const expiredStart = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
  const { WhatsAppEmbeddedSignupSession } = getModels()
  const crypto = require('node:crypto')
  const nonceHash = crypto.createHash('sha256').update(expiredStart.body.data.nonce, 'utf8').digest('hex')
  await WhatsAppEmbeddedSignupSession.update({
    expiresAt: new Date(Date.now() - 1000),
  }, { where: { nonceHash } })
  const expired = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      nonce: expiredStart.body.data.nonce,
      authorizationCode: 'AQB-2',
      wabaId: `waba-${uuidv4().slice(0, 8)}`,
      phoneNumberId: `phone-${uuidv4().slice(0, 8)}`,
    })
  assert.equal(expired.status, 400)
})

test('complete rejects invalid exchange, missing permissions, bad WABA/phone, and uniqueness conflicts', async () => {
  const admin = await registerVerifiedAdmin('WaReject')
  const other = await registerVerifiedAdmin('WaRejectOther')
  const takenWaba = `waba-taken-${uuidv4().slice(0, 6)}`
  const takenPhone = `phone-taken-${uuidv4().slice(0, 6)}`
  await upsertConnectedConfigForTests({
    companyId: other.companyId,
    userId: other.userId,
  }, {
    wabaId: takenWaba,
    phoneNumberId: takenPhone,
    accessToken: 'other-company-token',
  })

  const startExchangeFail = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
  graphClient.setFetchImpl(async (input) => {
    const url = String(input)
    if (url.includes('/oauth/access_token')) {
      return jsonResponse({ error: { message: 'Invalid code', code: 100 } }, 400)
    }
    throw new Error(`Unexpected Graph URL: ${url}`)
  })
  const exchangeFail = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      nonce: startExchangeFail.body.data.nonce,
      authorizationCode: 'bad-code',
      wabaId: 'waba-x',
      phoneNumberId: 'phone-x',
    })
  assert.equal(exchangeFail.status >= 400, true)

  const startPerm = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
  const wabaPerm = `waba-perm-${uuidv4().slice(0, 6)}`
  const phonePerm = `phone-perm-${uuidv4().slice(0, 6)}`
  installSuccessGraph({
    wabaId: wabaPerm,
    phoneNumberId: phonePerm,
    scopes: ['public_profile'],
  })
  const permFail = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      nonce: startPerm.body.data.nonce,
      authorizationCode: 'AQB-perm',
      wabaId: wabaPerm,
      phoneNumberId: phonePerm,
    })
  assert.equal(permFail.status, 403)

  const startPhone = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
  const wabaOk = `waba-ok-${uuidv4().slice(0, 6)}`
  installSuccessGraph({
    wabaId: wabaOk,
    phoneNumberId: 'phone-not-on-waba',
    phones: [{
      id: 'different-phone',
      display_phone_number: '+1 555 0199',
      verified_name: 'Other',
      quality_rating: 'GREEN',
    }],
  })
  const phoneFail = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      nonce: startPhone.body.data.nonce,
      authorizationCode: 'AQB-phone',
      wabaId: wabaOk,
      phoneNumberId: 'phone-not-on-waba',
    })
  assert.equal(phoneFail.status, 400)

  const startTaken = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${admin.token}`)
  const conflictPhone = `phone-new-${uuidv4().slice(0, 6)}`
  installSuccessGraph({ wabaId: takenWaba, phoneNumberId: conflictPhone })
  const taken = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      nonce: startTaken.body.data.nonce,
      authorizationCode: 'AQB-taken',
      wabaId: takenWaba,
      phoneNumberId: conflictPhone,
    })
  assert.equal(taken.status, 409)

  const { WhatsAppCompanyConfig } = getModels()
  const selfConfig = await WhatsAppCompanyConfig.findOne({ where: { companyId: admin.companyId } })
  assert.equal(selfConfig, null)
})

test('complete is company/user bound and isolates tenants', async () => {
  const companyA = await registerVerifiedAdmin('WaBoundA')
  const companyB = await registerVerifiedAdmin('WaBoundB')
  const startedA = await request(app)
    .post('/api/whatsapp/embedded-signup/start')
    .set('Authorization', `Bearer ${companyA.token}`)
  const wabaId = `waba-bound-${uuidv4().slice(0, 6)}`
  const phoneNumberId = `phone-bound-${uuidv4().slice(0, 6)}`
  installSuccessGraph({ wabaId, phoneNumberId })

  const stolen = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${companyB.token}`)
    .send({
      nonce: startedA.body.data.nonce,
      authorizationCode: 'AQB-steal',
      wabaId,
      phoneNumberId,
    })
  assert.equal(stolen.status, 400)

  const ok = await request(app)
    .post('/api/whatsapp/embedded-signup/complete')
    .set('Authorization', `Bearer ${companyA.token}`)
    .send({
      nonce: startedA.body.data.nonce,
      authorizationCode: 'AQB-ok',
      wabaId,
      phoneNumberId,
    })
  assert.equal(ok.status, 200)

  const getB = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${companyB.token}`)
  assert.equal(getB.body.data.config.connected, false)
  assert.equal(getB.body.data.config.wabaId, null)
})

test('config bootstrap exposes enabled flag without secrets; missing config returns 503', async () => {
  const admin = await registerVerifiedAdmin('WaBoot')
  const config = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(config.status, 200)
  assert.equal(config.body.data.embeddedSignup.enabled, true)
  assert.equal(config.body.data.embeddedSignup.appId, 'wa-app-111')
  assert.equal(JSON.stringify(config.body).includes('wa-app-secret'), false)

  const previous = process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED
  process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = '0'
  try {
    const disabled = await request(app)
      .post('/api/whatsapp/embedded-signup/start')
      .set('Authorization', `Bearer ${admin.token}`)
    assert.equal(disabled.status, 503)
  } finally {
    process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = previous
  }
})

test('Lead Ads authorization code exchange still requires redirect_uri', async () => {
  let sawRedirect = false
  graphClient.setFetchImpl(async (input) => {
    const url = String(input)
    if (url.includes('/oauth/access_token') && url.includes('redirect_uri')) {
      sawRedirect = true
      return jsonResponse({ access_token: 'lead-ads-token', expires_in: 3600 })
    }
    throw new Error(`Unexpected Graph URL: ${url}`)
  })
  const result = await graphClient.exchangeAuthorizationCode({
    appId: 'lead-app',
    appSecret: 'lead-secret',
    redirectUri: 'http://localhost:5001/api/meta/oauth/callback',
    code: 'lead-code',
  })
  assert.equal(result.accessToken, 'lead-ads-token')
  assert.equal(sawRedirect, true)
})
