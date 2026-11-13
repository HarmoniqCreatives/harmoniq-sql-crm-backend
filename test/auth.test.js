const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { hashSecret } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('registers a company, verifies email, logs in, refreshes, and logs out', async () => {
  clearMemoryOutbox()
  const companyName = uniqueName('Acme Auth')
  const email = `admin.${Date.now()}@example.com`

  const register = await request(app)
    .post('/api/auth/register')
    .send({
      companyName,
      adminName: 'Ada Admin',
      email,
      phone: '+919876543210',
      password: 'Password1!',
      confirmPassword: 'Password1!',
    })
  assert.equal(register.status, 201)
  assert.equal(register.body.data.emailDelivery, 'sent')

  const outbox = getMemoryOutbox()
  assert.equal(outbox.length >= 1, true)
  const link = outbox[outbox.length - 1].text.match(/token=([^\s]+)/)
  assert.ok(link)
  const token = decodeURIComponent(link[1])

  const unverifiedLogin = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'Password1!' })
  assert.equal(unverifiedLogin.status, 403)

  const verify = await request(app)
    .post('/api/auth/verify-email')
    .send({ token })
  assert.equal(verify.status, 200)

  const reuse = await request(app)
    .post('/api/auth/verify-email')
    .send({ token })
  // Token hash is cleared after success, so reuse is rejected as invalid.
  assert.equal(reuse.status, 400)

  const badLogin = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'WrongPass1!' })
  assert.equal(badLogin.status, 401)

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'Password1!' })
  assert.equal(login.status, 200)
  assert.ok(login.body.data.accessToken)
  assert.ok(login.body.data.refreshToken)
  assert.equal(login.body.data.user.company.name, companyName)

  const me = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${login.body.data.accessToken}`)
  assert.equal(me.status, 200)
  assert.equal(me.body.data.user.email, email)

  const refreshed = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: login.body.data.refreshToken })
  assert.equal(refreshed.status, 200)
  assert.ok(refreshed.body.data.accessToken)
  assert.notEqual(refreshed.body.data.refreshToken, login.body.data.refreshToken)

  const replay = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: login.body.data.refreshToken })
  assert.equal(replay.status, 401)

  const logout = await request(app)
    .post('/api/auth/logout')
    .send({ refreshToken: refreshed.body.data.refreshToken })
  assert.equal(logout.status, 200)

  const afterLogout = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: refreshed.body.data.refreshToken })
  assert.equal(afterLogout.status, 401)
})

test('rejects duplicate company registration', async () => {
  const companyName = uniqueName('Dup Co')
  const body = {
    companyName,
    adminName: 'One',
    email: `one.${Date.now()}@example.com`,
    phone: '+971501234567',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  }
  const first = await request(app).post('/api/auth/register').send(body)
  assert.equal(first.status, 201)
  const second = await request(app).post('/api/auth/register').send({
    ...body,
    email: `two.${Date.now()}@example.com`,
  })
  assert.equal(second.status, 409)
})

test('forgot and reset password revokes sessions', async () => {
  clearMemoryOutbox()
  const companyName = uniqueName('Reset Co')
  const email = `reset.${Date.now()}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Reset User',
    email,
    phone: '+441234567890',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  const verifyLink = getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)
  await request(app).post('/api/auth/verify-email').send({
    token: decodeURIComponent(verifyLink[1]),
  })
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)

  clearMemoryOutbox()
  const forgot = await request(app).post('/api/auth/forgot-password').send({ email })
  assert.equal(forgot.status, 200)
  const resetLink = getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)
  assert.ok(resetLink)

  const reset = await request(app).post('/api/auth/reset-password').send({
    token: decodeURIComponent(resetLink[1]),
    password: 'Password2!',
    confirmPassword: 'Password2!',
  })
  assert.equal(reset.status, 200)

  const oldRefresh = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: login.body.data.refreshToken })
  assert.equal(oldRefresh.status, 401)

  const newLogin = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password2!',
  })
  assert.equal(newLogin.status, 200)
})

test('keeps auth tenant-isolated for the same email in two companies', async () => {
  clearMemoryOutbox()
  const email = `shared.${Date.now()}@example.com`
  const firstName = uniqueName('Tenant A')
  const secondName = uniqueName('Tenant B')

  await request(app).post('/api/auth/register').send({
    companyName: firstName,
    adminName: 'Shared User',
    email,
    phone: '+12025550100',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  const firstToken = decodeURIComponent(getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1])
  await request(app).post('/api/auth/verify-email').send({ token: firstToken })

  await request(app).post('/api/auth/register').send({
    companyName: secondName,
    adminName: 'Shared User',
    email,
    phone: '+12025550111',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  const secondToken = decodeURIComponent(getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1])
  await request(app).post('/api/auth/verify-email').send({ token: secondToken })

  const companies = await request(app).get('/api/auth/companies').query({ email })
  assert.equal(companies.status, 200)
  assert.equal(companies.body.data.companies.length, 2)

  const missingCompany = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(missingCompany.status, 400)

  const companyA = companies.body.data.companies.find((row) => row.name === firstName)
  const loginA = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
    companyId: companyA.id,
  })
  assert.equal(loginA.status, 200)
  assert.equal(loginA.body.data.user.company.id, companyA.id)

  const me = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${loginA.body.data.accessToken}`)
  assert.equal(me.body.data.user.company.id, companyA.id)
})

test('expired verification token is rejected', async () => {
  clearMemoryOutbox()
  const email = `expire.${Date.now()}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName: uniqueName('Expire Co'),
    adminName: 'Expire User',
    email,
    phone: '+4915123456789',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  const { User } = getModels()
  const user = await User.findOne({ where: { email } })
  user.emailVerifyExpiresAt = new Date(Date.now() - 60_000)
  await user.save()
  const token = getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1]
  // Ensure hash still matches stored token
  assert.equal(user.emailVerifyTokenHash, hashSecret(decodeURIComponent(token)))
  const verify = await request(app)
    .post('/api/auth/verify-email')
    .send({ token: decodeURIComponent(token) })
  assert.equal(verify.status, 400)
})

test('logout-all revokes every active session for the user', async () => {
  clearMemoryOutbox()
  const email = `logoutall.${Date.now()}@example.com`
  await request(app).post('/api/auth/register').send({
    companyName: uniqueName('Logout All Co'),
    adminName: 'Logout All',
    email,
    phone: '+33123456789',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  const token = decodeURIComponent(getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1])
  await request(app).post('/api/auth/verify-email').send({ token })

  const first = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  const second = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)

  const logoutAll = await request(app)
    .post('/api/auth/logout-all')
    .set('Authorization', `Bearer ${first.body.data.accessToken}`)
  assert.equal(logoutAll.status, 200)

  const refreshFirst = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: first.body.data.refreshToken })
  const refreshSecond = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: second.body.data.refreshToken })
  assert.equal(refreshFirst.status, 401)
  assert.equal(refreshSecond.status, 401)
})
