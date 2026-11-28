'use strict'

/**
 * Step 9 — Migration auth verification (synthetic credentials only).
 * Does not attempt login with real migrated user passwords.
 * Creates disposable tenants via /api/auth/register (same pattern as auth.test.js).
 */


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
const jwt = require('jsonwebtoken')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { companyStatuses, permissionKeys, roleKeys, userStatuses } = require('../src/utils/enums')
const { readEnv } = require('../src/config/env')
const env = readEnv()

const FALCON_ID = '419c2afa-c979-448c-9457-370b8049ac0f'
const SYNTH_PASSWORD = 'SynthPass1!'
const WRONG_PASSWORD = 'WrongPass9!'

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerified(prefix) {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `${prefix.toLowerCase()}.${Date.now()}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Synth Admin',
    email,
    phone: '+971501234567',
    password: SYNTH_PASSWORD,
    confirmPassword: SYNTH_PASSWORD,
  })
  assert.equal(register.status, 201)
  const token = decodeURIComponent(getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1])
  const verify = await request(app).post('/api/auth/verify-email').send({ token })
  assert.equal(verify.status, 200)
  return { email, companyName, companyId: register.body.data.companyId, userId: register.body.data.userId }
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('migrated Falcon users are auth-compatible (read-only shape check)', async () => {
  const { User, Role, Company } = getModels()
  const company = await Company.findByPk(FALCON_ID)
  assert.ok(company)
  assert.equal(company.name, 'Falcon Premier')
  assert.equal(company.status, companyStatuses.active)

  const users = await User.findAll({ where: { companyId: FALCON_ID } })
  assert.equal(users.length, 12)

  for (const user of users) {
    assert.equal(user.companyId, FALCON_ID)
    assert.equal(user.status, userStatuses.active)
    assert.equal(user.emailVerified, true)
    assert.equal(user.branchId, null)
    assert.equal(user.teamId, null)
    assert.ok(user.passwordHash)
    assert.match(user.passwordHash, /^\$2[aby]\$\d{2}\$/)
    const role = await Role.findByPk(user.roleId)
    assert.ok(role)
    assert.equal(role.companyId, user.companyId)
    assert.ok(Array.isArray(role.permissions))
    assert.ok(role.permissions.length > 0)
  }
})

test('correct synthetic password accepted; wrong password rejected', async () => {
  const { email } = await registerVerified('MigAuthOk')
  const bad = await request(app).post('/api/auth/login').send({ email, password: WRONG_PASSWORD })
  assert.equal(bad.status, 401)

  const ok = await request(app).post('/api/auth/login').send({ email, password: SYNTH_PASSWORD })
  assert.equal(ok.status, 200)
  assert.ok(ok.body.data.accessToken)
  assert.ok(ok.body.data.user.role.permissions.length > 0)
  assert.equal(ok.body.data.user.company.status, companyStatuses.active)
})

test('disabled user rejected at login', async () => {
  const { email, userId } = await registerVerified('MigAuthDis')
  const { User } = getModels()
  await User.update({ status: userStatuses.disabled }, { where: { id: userId } })

  const login = await request(app).post('/api/auth/login').send({ email, password: SYNTH_PASSWORD })
  assert.equal(login.status, 403)
})

test('inactive / invalid company rejected at login', async () => {
  const { email, companyId } = await registerVerified('MigAuthCo')
  const { Company } = getModels()

  await Company.update({ status: companyStatuses.disabled, isActive: false }, { where: { id: companyId } })
  const disabled = await request(app).post('/api/auth/login').send({ email, password: SYNTH_PASSWORD })
  assert.equal(disabled.status, 403)

  await Company.update({ status: companyStatuses.pendingVerification, isActive: false }, { where: { id: companyId } })
  const pending = await request(app).post('/api/auth/login').send({ email, password: SYNTH_PASSWORD })
  assert.equal(pending.status, 403)
})

test('cross-company / missing role rejected at login and requireAuth', async () => {
  const a = await registerVerified('MigAuthRoleA')
  const b = await registerVerified('MigAuthRoleB')
  const { User, Role } = getModels()

  const foreignRole = await Role.findOne({ where: { companyId: b.companyId, key: roleKeys.agent } })
  assert.ok(foreignRole)

  // Point user A at company B's role (cross-company) — login must fail
  await User.update({ roleId: foreignRole.id }, { where: { id: a.userId } })
  const login = await request(app).post('/api/auth/login').send({
    email: a.email,
    password: SYNTH_PASSWORD,
  })
  assert.equal(login.status, 401)

  // Restore valid role, login, then break role again and hit /me with still-valid JWT
  const ownRole = await Role.findOne({ where: { companyId: a.companyId, key: roleKeys.superAdmin } })
  await User.update({ roleId: ownRole.id }, { where: { id: a.userId } })
  const ok = await request(app).post('/api/auth/login').send({
    email: a.email,
    password: SYNTH_PASSWORD,
  })
  assert.equal(ok.status, 200)

  await User.update({ roleId: foreignRole.id }, { where: { id: a.userId } })
  const me = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${ok.body.data.accessToken}`)
  assert.equal(me.status, 401)

  // Orphan roleId blocked by DB FK (users.roleId → roles.id RESTRICT)
  await assert.rejects(
    () => User.update({ roleId: uuidv4() }, { where: { id: a.userId } }),
    (err) => err.name === 'SequelizeForeignKeyConstraintError',
  )
})

test('valid JWT accepted; invalid and expired JWT rejected', async () => {
  const { email } = await registerVerified('MigAuthJwt')
  const login = await request(app).post('/api/auth/login').send({ email, password: SYNTH_PASSWORD })
  assert.equal(login.status, 200)

  const me = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${login.body.data.accessToken}`)
  assert.equal(me.status, 200)
  assert.equal(me.body.data.user.email, email)

  const garbage = await request(app)
    .get('/api/auth/me')
    .set('Authorization', 'Bearer not-a-real-token')
  assert.equal(garbage.status, 401)

  const expired = jwt.sign(
    { sub: login.body.data.user.id, companyId: login.body.data.user.company.id, sid: 'fake' },
    env.jwtAccessSecret,
    { expiresIn: -10 },
  )
  const expiredRes = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${expired}`)
  assert.equal(expiredRes.status, 401)
})

test('protected routes enforce permissions (agent forbidden on users.invite)', async () => {
  const admin = await registerVerified('MigAuthPerm')
  const { User, Role } = getModels()
  const roles = await Role.findAll({ where: { companyId: admin.companyId } })
  const agentRole = roles.find((r) => r.key === roleKeys.agent)
  assert.ok(agentRole)
  assert.equal(agentRole.permissions.includes(permissionKeys.usersInvite), false)

  // Demote synthetic admin to agent for permission check
  await User.update({ roleId: agentRole.id, isInitialSuperAdmin: false }, { where: { id: admin.userId } })
  const login = await request(app).post('/api/auth/login').send({
    email: admin.email,
    password: SYNTH_PASSWORD,
  })
  assert.equal(login.status, 200)
  assert.equal(login.body.data.user.role.key, roleKeys.agent)

  const forbidden = await request(app)
    .post('/api/invitations')
    .set('Authorization', `Bearer ${login.body.data.accessToken}`)
    .send({
      name: 'Should Fail',
      email: `fail.${Date.now()}@example.com`,
      roleId: agentRole.id,
    })
  assert.equal(forbidden.status, 403)

  // Super admin path: restore and confirm invite allowed
  const saRole = roles.find((r) => r.key === roleKeys.superAdmin)
  await User.update({ roleId: saRole.id, isInitialSuperAdmin: true }, { where: { id: admin.userId } })
  const saLogin = await request(app).post('/api/auth/login').send({
    email: admin.email,
    password: SYNTH_PASSWORD,
  })
  assert.equal(saLogin.status, 200)
  const allowed = await request(app)
    .post('/api/invitations')
    .set('Authorization', `Bearer ${saLogin.body.data.accessToken}`)
    .send({
      name: 'Invitee',
      email: `ok.${Date.now()}@example.com`,
      roleId: agentRole.id,
    })
  assert.equal(allowed.status, 201)
})
