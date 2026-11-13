const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = 'https://crm.example.com'
process.env.FRONTEND_URL = 'https://crm.example.com'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { catalogKinds, roleKeys } = require('../src/utils/enums')
const { seedCompanyCatalog } = require('../src/scripts/seedCatalogDefaults')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'Co') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `${prefix.toLowerCase()}.${Date.now()}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Admin User',
    email,
    phone: '+919876543210',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  assert.equal(register.status, 201)
  const token = decodeURIComponent(getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1])
  await request(app).post('/api/auth/verify-email').send({ token })
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)
  return {
    email,
    companyId: login.body.data.user.company.id,
    accessToken: login.body.data.accessToken,
    user: login.body.data.user,
  }
}

async function authGet(token, url) {
  return request(app).get(url).set('Authorization', `Bearer ${token}`)
}

async function authPost(token, url, body = {}) {
  return request(app).post(url).set('Authorization', `Bearer ${token}`).send(body)
}

async function authPatch(token, url, body = {}) {
  return request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body)
}

async function authDelete(token, url) {
  return request(app).delete(url).set('Authorization', `Bearer ${token}`)
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('lists default catalogs including Angry tag and 11 statuses', async () => {
  const admin = await registerVerifiedAdmin('CatSeed')
  const statuses = await authGet(admin.accessToken, '/api/catalog?kind=STATUS')
  assert.equal(statuses.status, 200)
  assert.equal(statuses.body.data.items.length, 11)
  assert.ok(statuses.body.data.items.every((row) => row.isSystem && row.isActive))

  const tags = await authGet(admin.accessToken, '/api/catalog?kind=TAG')
  assert.equal(tags.status, 200)
  assert.equal(tags.body.data.items.length, 4)
  assert.ok(tags.body.data.items.some((row) => row.key === 'angry' && row.name === 'Angry' && row.tone === 'red'))

  const activities = await authGet(admin.accessToken, '/api/catalog?kind=ACTIVITY')
  assert.equal(activities.status, 200)
  assert.equal(activities.body.data.items.length, 4)
})

test('catalog CRUD, deactivate, system delete blocked, name uniqueness', async () => {
  const admin = await registerVerifiedAdmin('CatCrud')
  const created = await authPost(admin.accessToken, '/api/catalog', {
    kind: 'STATUS',
    name: 'Custom Pipeline',
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.item.isSystem, false)
  assert.equal(created.body.data.item.kind, 'STATUS')

  const duplicate = await authPost(admin.accessToken, '/api/catalog', {
    kind: 'STATUS',
    name: 'custom pipeline',
  })
  assert.equal(duplicate.status, 409)

  const tag = await authPost(admin.accessToken, '/api/catalog', {
    kind: 'TAG',
    name: 'Hot',
    tone: 'amber',
  })
  assert.equal(tag.status, 201)
  assert.equal(tag.body.data.item.tone, 'amber')

  const badTone = await authPost(admin.accessToken, '/api/catalog', {
    kind: 'TAG',
    name: 'No Color',
  })
  assert.equal(badTone.status, 400)

  const patched = await authPatch(admin.accessToken, `/api/catalog/${created.body.data.item.id}`, {
    name: 'Custom Pipeline 2',
    sortOrder: 20,
    isActive: false,
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.data.item.isActive, false)

  const activeOnly = await authGet(admin.accessToken, '/api/catalog?kind=STATUS')
  assert.equal(activeOnly.body.data.items.some((row) => row.id === created.body.data.item.id), false)

  const withInactive = await authGet(admin.accessToken, '/api/catalog?kind=STATUS&includeInactive=true')
  assert.ok(withInactive.body.data.items.some((row) => row.id === created.body.data.item.id))

  const system = withInactive.body.data.items.find((row) => row.key === 'new')
  const deleteSystem = await authDelete(admin.accessToken, `/api/catalog/${system.id}`)
  assert.equal(deleteSystem.status, 400)

  const deleted = await authDelete(admin.accessToken, `/api/catalog/${created.body.data.item.id}`)
  assert.equal(deleted.status, 200)

  const gone = await authGet(admin.accessToken, '/api/catalog?kind=STATUS&includeInactive=true')
  assert.equal(gone.body.data.items.some((row) => row.id === created.body.data.item.id), false)
})

test('catalog and company require permissions; agent cannot mutate', async () => {
  const admin = await registerVerifiedAdmin('CatPerm')
  const { User, Role } = getModels()
  const agentRole = await Role.findOne({ where: { companyId: admin.companyId, key: roleKeys.agent } })
  const { hashPassword } = require('../src/utils/helpers')
  const agent = await User.create({
    id: uuidv4(),
    companyId: admin.companyId,
    roleId: agentRole.id,
    name: 'Agent',
    email: `agent.cat.${Date.now()}@example.com`,
    passwordHash: await hashPassword('Password1!'),
    status: 'ACTIVE',
    emailVerified: true,
  })
  const login = await request(app).post('/api/auth/login').send({
    email: agent.email,
    password: 'Password1!',
    companyId: admin.companyId,
  })
  assert.equal(login.status, 200)
  const token = login.body.data.accessToken

  const list = await authGet(token, '/api/catalog?kind=STATUS')
  assert.equal(list.status, 200)

  const create = await authPost(token, '/api/catalog', { kind: 'STATUS', name: 'Nope' })
  assert.equal(create.status, 403)

  const companyPatch = await authPatch(token, '/api/company', {
    timezone: 'Asia/Dubai',
    baseCurrency: 'INR',
  })
  assert.equal(companyPatch.status, 403)
})

test('company GET/PATCH timezone and base currency', async () => {
  const admin = await registerVerifiedAdmin('CoSettings')
  const current = await authGet(admin.accessToken, '/api/company')
  assert.equal(current.status, 200)
  assert.ok(current.body.data.company.enabledCurrencies.includes(current.body.data.company.baseCurrency))

  const updated = await authPatch(admin.accessToken, '/api/company', {
    timezone: 'Asia/Dubai',
    baseCurrency: current.body.data.company.enabledCurrencies[0],
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.data.company.timezone, 'Asia/Dubai')

  const badTz = await authPatch(admin.accessToken, '/api/company', {
    timezone: 'Mars/Olympus',
    baseCurrency: current.body.data.company.baseCurrency,
  })
  assert.equal(badTz.status, 400)

  const badCurrency = await authPatch(admin.accessToken, '/api/company', {
    timezone: 'Asia/Dubai',
    baseCurrency: 'XXX',
  })
  assert.equal(badCurrency.status, 400)
})

test('cross-tenant catalog isolation', async () => {
  const first = await registerVerifiedAdmin('CatA')
  const second = await registerVerifiedAdmin('CatB')
  const created = await authPost(first.accessToken, '/api/catalog', {
    kind: 'TAG',
    name: 'Secret Tag',
    tone: 'blue',
  })
  assert.equal(created.status, 201)
  const stolen = await authPatch(second.accessToken, `/api/catalog/${created.body.data.item.id}`, {
    name: 'Hijacked',
  })
  assert.equal(stolen.status, 400)
  const deleteStolen = await authDelete(second.accessToken, `/api/catalog/${created.body.data.item.id}`)
  assert.equal(deleteStolen.status, 400)
})

test('catalog seed script is idempotent and inserts missing Angry', async () => {
  const admin = await registerVerifiedAdmin('CatIdem')
  const { sequelize, CatalogItem } = getModels()
  await CatalogItem.destroy({
    where: { companyId: admin.companyId, kind: catalogKinds.tag, key: 'angry' },
  })
  await sequelize.transaction(async (transaction) => {
    await seedCompanyCatalog(admin.companyId, CatalogItem, transaction)
  })
  const tags = await authGet(admin.accessToken, '/api/catalog?kind=TAG')
  assert.ok(tags.body.data.items.some((row) => row.key === 'angry'))
  const before = tags.body.data.items.length
  await sequelize.transaction(async (transaction) => {
    await seedCompanyCatalog(admin.companyId, CatalogItem, transaction)
  })
  const again = await authGet(admin.accessToken, '/api/catalog?kind=TAG')
  assert.equal(again.body.data.items.length, before)
})
