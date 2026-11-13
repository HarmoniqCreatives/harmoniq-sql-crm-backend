const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { after, before, beforeEach, test } = require('node:test')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.META_SYNC_AUTORUN = '0'
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token'
process.env.META_APP_SECRET = 'test-app-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_REDIRECT_URI = 'http://localhost:5001/api/meta/oauth/callback'
process.env.APP_BASE_URL = 'http://localhost:5174'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex')

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const graphClient = require('../src/services/metaGraph')
const { consumeState, startOAuth } = require('../src/services/metaService')
const {
  decryptSecret,
  encryptSecret,
} = require('../src/utils/metaSecrets')
const { permissionKeys } = require('../src/utils/enums')
const { hashSecret } = require('../src/utils/helpers')
const { messages } = require('../src/utils/messages')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'Meta') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `admin.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Meta Admin',
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
  }
}

function signBody(raw, secret = process.env.META_APP_SECRET) {
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  return `sha256=${digest}`
}

function mockGraphSequential(handlers) {
  let i = 0
  graphClient.setFetchImpl(async (input, init) => {
    const url = String(input)
    const handler = handlers[i]
    i += 1
    if (!handler) {
      throw new Error(`Unexpected Graph call: ${url}`)
    }
    return handler(url, init)
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
  graphClient.resetFetchImpl()
})

beforeEach(() => {
  graphClient.resetFetchImpl()
})

test('OAuth scopes match legacy required set and omit pages_manage_ads', () => {
  const requested = String(messages.metaOAuthScope).split(',').map((s) => s.trim())
  const required = String(messages.metaRequiredPermissions).split(',').map((s) => s.trim())
  for (const scope of [
    'public_profile',
    'pages_show_list',
    'pages_read_engagement',
    'leads_retrieval',
    'pages_manage_metadata',
    'business_management',
    'ads_read',
  ]) {
    assert.ok(requested.includes(scope), `missing requested scope ${scope}`)
  }
  assert.equal(requested.includes('pages_manage_ads'), false)
  for (const scope of [
    'pages_show_list',
    'pages_read_engagement',
    'leads_retrieval',
    'pages_manage_metadata',
    'ads_read',
  ]) {
    assert.ok(required.includes(scope), `missing required scope ${scope}`)
  }
  assert.equal(required.includes('pages_manage_ads'), false)
  assert.equal(required.includes('business_management'), false)
})

test('encrypts and decrypts Meta secrets with key version and detects tampering', () => {
  const stored = encryptSecret('plain-secret-value')
  assert.equal(typeof stored.cipherText, 'string')
  assert.equal(typeof stored.iv, 'string')
  assert.equal(typeof stored.tag, 'string')
  assert.equal(stored.keyVersion, 1)
  assert.equal(decryptSecret(stored), 'plain-secret-value')
  const tampered = { ...stored, cipherText: Buffer.from('nope').toString('base64') }
  assert.throws(() => decryptSecret(tampered))
})

test('OAuth state is single-use, expires, and rejects mismatch', async () => {
  const admin = await registerVerifiedAdmin('OAuthState')
  const { MetaAppProfile, MetaOAuthState } = getModels()
  const profile = await MetaAppProfile.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    mode: 'customer',
    label: 'Customer App',
    appId: '111',
    appSecretCipher: encryptSecret('secret'),
    secretStored: true,
    isActive: true,
    createdBy: admin.userId,
    updatedBy: admin.userId,
  })

  const auth = { companyId: admin.companyId, userId: admin.userId }
  const url = await startOAuth(auth, { profileId: profile.id })
  assert.match(url, /facebook\.com/)
  assert.match(url, /state=/)
  const state = new URL(url).searchParams.get('state')
  const first = await consumeState(state)
  assert.ok(first)
  const reused = await consumeState(state)
  assert.equal(reused, null)

  const expiredRaw = `expired-state-${crypto.randomUUID()}`
  await MetaOAuthState.create({
    id: crypto.randomUUID(),
    stateHash: hashSecret(expiredRaw),
    companyId: admin.companyId,
    userId: admin.userId,
    appProfileId: profile.id,
    expiresAt: new Date(Date.now() - 60_000),
    usedAt: null,
    connectionLabel: '',
    rerequest: false,
  })
  assert.equal(await consumeState(expiredRaw), null)
  assert.equal(await consumeState('totally-wrong'), null)
})

test('OAuth callback rejects invalid state and missing code', async () => {
  const badState = await request(app).get('/api/meta/oauth/callback').query({ code: 'x' })
  assert.equal(badState.status, 302)
  assert.match(badState.headers.location, /meta=error/)

  const badCode = await request(app).get('/api/meta/oauth/callback').query({ state: 'abc' })
  assert.equal(badCode.status, 302)
  assert.match(badCode.headers.location, /meta=error/)
})

test('OAuth callback stores declined permissions and never returns tokens', async () => {
  const admin = await registerVerifiedAdmin('OAuthCb')
  const create = await request(app)
    .post('/api/meta/profiles')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      mode: 'customer',
      label: 'Ads App',
      appId: 'app-1',
      appSecret: 'super-secret-value',
    })
  assert.equal(create.status, 201)
  assert.equal(create.body.data.profile.secretStored, true)
  assert.equal('appSecret' in create.body.data.profile, false)
  assert.equal(JSON.stringify(create.body).includes('super-secret-value'), false)

  const start = await request(app)
    .post('/api/meta/oauth/start')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ profileId: create.body.data.profile.id })
  assert.equal(start.status, 200)
  const state = new URL(start.body.data.url).searchParams.get('state')

  mockGraphSequential([
    () => jsonResponse({ access_token: 'short-token', expires_in: 3600 }),
    () => jsonResponse({ access_token: 'long-token', expires_in: 5184000 }),
    () => jsonResponse({ id: 'fb-user-1', name: 'FB User' }),
    () => jsonResponse({
      data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_read_engagement', status: 'granted' },
        { permission: 'pages_manage_metadata', status: 'granted' },
        { permission: 'ads_read', status: 'granted' },
        { permission: 'leads_retrieval', status: 'declined' },
        { permission: 'email', status: 'declined' },
      ],
    }),
    () => jsonResponse({ data: [] }),
  ])

  const callback = await request(app).get('/api/meta/oauth/callback').query({ state, code: 'auth-code' })
  assert.equal(callback.status, 302)
  assert.equal(JSON.stringify(callback.headers).includes('long-token'), false)

  const connections = await request(app)
    .get('/api/meta/connections')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(connections.status, 200)
  assert.equal(connections.body.data.connections.length, 1)
  const connection = connections.body.data.connections[0]
  assert.ok(connection.declinedPermissions.includes('leads_retrieval'))
  assert.ok(connection.missingPermissions.includes('leads_retrieval'))
  assert.equal(JSON.stringify(connections.body).includes('long-token'), false)
  assert.equal(JSON.stringify(connections.body).includes('cipherText'), false)
})

test('webhook verification accepts correct token and rejects wrong token', async () => {
  const ok = await request(app).get('/api/meta/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'test-verify-token',
    'hub.challenge': 'challenge-123',
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.text, 'challenge-123')

  const bad = await request(app).get('/api/meta/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong',
    'hub.challenge': 'challenge-123',
  })
  assert.equal(bad.status, 403)
})

test('webhook signature validates raw body; duplicates and unknown pages are safe', async () => {
  const admin = await registerVerifiedAdmin('Webhook')
  const { MetaAppProfile, MetaConnection, MetaPage, MetaWebhookIngestion } = getModels()
  const profile = await MetaAppProfile.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    mode: 'customer',
    label: 'Hook App',
    appId: 'app-hook',
    appSecretCipher: encryptSecret(process.env.META_APP_SECRET),
    secretStored: true,
    isActive: true,
    createdBy: admin.userId,
    updatedBy: admin.userId,
  })
  const connection = await MetaConnection.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    appProfileId: profile.id,
    metaUserId: 'mu-1',
    displayName: 'User',
    status: 'connected',
    grantedPermissions: [],
    declinedPermissions: [],
    missingPermissions: [],
    pageFetchErrors: [],
    connectedBy: admin.userId,
    tokenCipher: encryptSecret('user-token'),
  })
  const page = await MetaPage.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    connectionId: connection.id,
    appProfileId: profile.id,
    pageId: 'page-99',
    name: 'Page 99',
    status: 'connected',
    tokenCipher: encryptSecret('page-token'),
    webhookSubscribed: true,
  })

  const payload = {
    object: 'page',
    entry: [{
      id: 'page-99',
      changes: [{
        field: 'leadgen',
        value: { page_id: 'page-99', leadgen_id: 'lead-1', form_id: 'form-1' },
      }],
    }],
  }
  // Supertest JSON-encodes Buffer objects; send the exact UTF-8 bytes as a string.
  const rawText = JSON.stringify(payload)
  const raw = Buffer.from(rawText)

  const missingSig = await request(app)
    .post('/api/meta/webhook')
    .set('Content-Type', 'application/json')
    .send(rawText)
  assert.equal(missingSig.status, 401)

  const badSig = await request(app)
    .post('/api/meta/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', 'sha256=deadbeef')
    .send(rawText)
  assert.equal(badSig.status, 401)

  const ok = await request(app)
    .post('/api/meta/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(raw))
    .send(rawText)
  assert.equal(ok.status, 200)

  const dup = await request(app)
    .post('/api/meta/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(raw))
    .send(rawText)
  assert.equal(dup.status, 200)

  const rows = await MetaWebhookIngestion.findAll({
    where: { companyId: admin.companyId, leadgenId: 'lead-1' },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'pending')
  assert.equal(rows[0].metaPageId, page.id)

  const unknownPayload = {
    object: 'page',
    entry: [{
      id: 'unknown-page',
      changes: [{
        field: 'leadgen',
        value: { page_id: 'unknown-page', leadgen_id: 'lead-x' },
      }],
    }],
  }
  const unknownText = JSON.stringify(unknownPayload)
  const unknownRaw = Buffer.from(unknownText)
  const unknown = await request(app)
    .post('/api/meta/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(unknownRaw))
    .send(unknownText)
  assert.equal(unknown.status, 200)

  const unknownRows = await MetaWebhookIngestion.findAll({ where: { leadgenId: 'lead-x' } })
  assert.equal(unknownRows.length, 1)
  assert.equal(unknownRows[0].status, 'ignored')
  assert.equal(unknownRows[0].companyId, null)
  assert.equal(unknownRows[0].metaPageId, null)
  assert.equal(unknownRows[0].pageId, 'unknown-page')
  assert.equal(unknownRows[0].dedupeKey, 'ignored:unknown-page:lead-x')

  const unknownDup = await request(app)
    .post('/api/meta/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(unknownRaw))
    .send(unknownText)
  assert.equal(unknownDup.status, 200)
  const unknownAfterDup = await MetaWebhookIngestion.findAll({ where: { leadgenId: 'lead-x' } })
  assert.equal(unknownAfterDup.length, 1)
})

test('page connect rejects unauthorized IDs, reports subscription failure, disconnect is idempotent', async () => {
  const admin = await registerVerifiedAdmin('Pages')
  const profile = await request(app)
    .post('/api/meta/profiles')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      mode: 'customer',
      label: 'Page App',
      appId: 'app-pages',
      appSecret: 'page-secret',
    })
  assert.equal(profile.status, 201)

  const { MetaConnection } = getModels()
  const connection = await MetaConnection.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    appProfileId: profile.body.data.profile.id,
    metaUserId: 'mu-pages',
    displayName: 'Pages User',
    status: 'connected',
    grantedPermissions: ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'leads_retrieval'],
    declinedPermissions: [],
    missingPermissions: [],
    pageFetchErrors: [],
    connectedBy: admin.userId,
    tokenCipher: encryptSecret('user-token'),
  })

  mockGraphSequential([
    () => jsonResponse({
      data: [
        { id: 'page-ok', name: 'OK Page', access_token: 'page-token-ok' },
      ],
    }),
  ])

  const unauthorized = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['not-owned'] })
  assert.equal(unauthorized.status, 200)
  assert.equal(unauthorized.body.data.results[0].status, 'failed')

  graphClient.resetFetchImpl()
  mockGraphSequential([
    () => jsonResponse({
      data: [
        { id: 'page-ok', name: 'OK Page', access_token: 'page-token-ok' },
      ],
    }),
    () => jsonResponse({ success: true }),
  ])
  const added = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-ok'] })
  assert.equal(added.status, 200)
  assert.equal(added.body.data.results[0].status, 'added')
  assert.equal(added.body.data.results[0].page.webhookSubscribed, true)
  assert.equal(added.body.data.results[0].initialSyncStarted, true)
  assert.ok(added.body.data.results[0].syncJob?.id)
  assert.equal(JSON.stringify(added.body).includes('page-token-ok'), false)
  const { MetaSyncJob } = getModels()
  const jobsAfterAdd = await MetaSyncJob.findAll({
    where: { companyId: admin.companyId, facebookPageId: 'page-ok' },
  })
  assert.equal(jobsAfterAdd.length, 1)

  graphClient.resetFetchImpl()
  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-ok', name: 'OK Page', access_token: 'page-token-ok' }],
    }),
  ])
  const skipped = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-ok'] })
  assert.equal(skipped.body.data.results[0].status, 'skipped')

  graphClient.resetFetchImpl()
  mockGraphSequential([
    () => jsonResponse({
      data: [{ id: 'page-fail', name: 'Fail Page', access_token: 'page-token-fail' }],
    }),
    () => jsonResponse({ error: { message: 'denied', code: 200 } }, 400),
  ])
  const failedSub = await request(app)
    .post(`/api/meta/connections/${connection.id}/pages`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pageIds: ['page-fail'] })
  assert.equal(failedSub.body.data.results[0].status, 'failed')
  assert.ok(failedSub.body.data.results[0].reason)

  const pages = await request(app)
    .get('/api/meta/pages')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(pages.status, 200)
  const connectedPage = pages.body.data.pages.find((row) => row.pageId === 'page-ok')
  assert.ok(connectedPage)

  graphClient.setFetchImpl(async () => {
    throw new Error('meta down')
  })
  const disconnect = await request(app)
    .post(`/api/meta/pages/${connectedPage.id}/disconnect`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(disconnect.status, 200)
  assert.equal(disconnect.body.data.page.status, 'disconnected')

  const again = await request(app)
    .post(`/api/meta/pages/${connectedPage.id}/disconnect`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(again.status, 200)
  assert.equal(again.body.data.page.status, 'disconnected')
})

test('Graph error 190 marks connection expired on available-pages', async () => {
  const admin = await registerVerifiedAdmin('Expired')
  const profile = await request(app)
    .post('/api/meta/profiles')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      mode: 'customer',
      label: 'Exp App',
      appId: 'app-exp',
      appSecret: 'exp-secret',
    })
  const { MetaConnection } = getModels()
  const connection = await MetaConnection.create({
    id: crypto.randomUUID(),
    companyId: admin.companyId,
    appProfileId: profile.body.data.profile.id,
    metaUserId: 'mu-exp',
    displayName: 'Exp',
    status: 'connected',
    grantedPermissions: [],
    declinedPermissions: [],
    missingPermissions: [],
    pageFetchErrors: [],
    connectedBy: admin.userId,
    tokenCipher: encryptSecret('expired-user-token'),
  })

  mockGraphSequential([
    () => jsonResponse({ error: { message: 'invalid', code: 190 } }, 400),
  ])
  const res = await request(app)
    .get(`/api/meta/connections/${connection.id}/available-pages`)
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'META_TOKEN_EXPIRED')
  await connection.reload()
  assert.equal(connection.status, 'expired')
})

test('wrong encryption key cannot decrypt ciphertext', () => {
  const stored = encryptSecret('round-trip')
  const previous = process.env.META_TOKEN_ENCRYPTION_KEY
  process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('hex')
  assert.throws(() => decryptSecret(stored))
  process.env.META_TOKEN_ENCRYPTION_KEY = previous
})

test('tenant isolation returns 404 across companies', async () => {
  const a = await registerVerifiedAdmin('TenantA')
  const b = await registerVerifiedAdmin('TenantB')
  const profileA = await request(app)
    .post('/api/meta/profiles')
    .set('Authorization', `Bearer ${a.token}`)
    .send({
      mode: 'customer',
      label: 'A App',
      appId: 'a',
      appSecret: 'secret-a',
    })
  const listB = await request(app)
    .get('/api/meta/profiles')
    .set('Authorization', `Bearer ${b.token}`)
  assert.equal(listB.body.data.profiles.length, 0)

  const patch = await request(app)
    .patch(`/api/meta/profiles/${profileA.body.data.profile.id}`)
    .set('Authorization', `Bearer ${b.token}`)
    .send({ label: 'Stolen' })
  assert.equal(patch.status, 404)

  const { MetaConnection, MetaPage } = getModels()
  const connection = await MetaConnection.create({
    id: crypto.randomUUID(),
    companyId: a.companyId,
    appProfileId: profileA.body.data.profile.id,
    metaUserId: 'mu-a',
    displayName: 'A',
    status: 'connected',
    grantedPermissions: [],
    declinedPermissions: [],
    missingPermissions: [],
    pageFetchErrors: [],
    connectedBy: a.userId,
    tokenCipher: encryptSecret('tok'),
  })
  const page = await MetaPage.create({
    id: crypto.randomUUID(),
    companyId: a.companyId,
    connectionId: connection.id,
    pageId: 'p-a',
    name: 'A Page',
    status: 'connected',
    tokenCipher: encryptSecret('pt'),
  })

  const disconnect = await request(app)
    .post(`/api/meta/pages/${page.id}/disconnect`)
    .set('Authorization', `Bearer ${b.token}`)
  assert.equal(disconnect.status, 404)
})

test('permission enforcement returns 401 and 403', async () => {
  const unauth = await request(app).get('/api/meta/profiles')
  assert.equal(unauth.status, 401)

  const admin = await registerVerifiedAdmin('Perms')
  const { Role, User } = getModels()
  const user = await User.findByPk(admin.userId)
  const role = await Role.findByPk(user.roleId)
  role.permissions = role.permissions.filter((key) => key !== permissionKeys.metaManage)
  role.permissions = role.permissions.filter((key) => key !== permissionKeys.metaPagesManage)
  role.permissions = role.permissions.filter((key) => key !== permissionKeys.metaView)
  await role.save()

  const forbidden = await request(app)
    .get('/api/meta/profiles')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(forbidden.status, 403)
})

test('callback rejects when initiating user loses Meta permission', async () => {
  const admin = await registerVerifiedAdmin('LostPerm')
  const profile = await request(app)
    .post('/api/meta/profiles')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      mode: 'customer',
      label: 'Lost App',
      appId: 'lost',
      appSecret: 'lost-secret',
    })
  const start = await request(app)
    .post('/api/meta/oauth/start')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ profileId: profile.body.data.profile.id })
  const state = new URL(start.body.data.url).searchParams.get('state')

  const { Role, User } = getModels()
  const user = await User.findByPk(admin.userId)
  const role = await Role.findByPk(user.roleId)
  role.permissions = []
  await role.save()

  const callback = await request(app).get('/api/meta/oauth/callback').query({ state, code: 'x' })
  assert.equal(callback.status, 302)
  assert.match(callback.headers.location, /meta=error/)
})
