'use strict'

/**
 * HTTP-level Super Admin permission policy checks.
 *
 * SAFETY: runs only when DB_NAME_TEST is set and differs from DB_NAME.
 * Never points at production.
 */


const {
  isolatedTestDbConfigured,
  applyIsolatedTestDbEnv,
  assertIsolatedTestDbOrThrow,
} = require('./helpers/isolatedTestDb')
assertIsolatedTestDbOrThrow()
applyIsolatedTestDbEnv()

const assert = require('node:assert/strict')
const { test } = require('node:test')
const request = require('supertest')

process.env.MAIL_DRIVER = process.env.MAIL_DRIVER || 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://crm.example.com'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://crm.example.com'


const RUN = isolatedTestDbConfigured()
if (RUN) {
  process.env.DB_NAME = process.env.DB_NAME_TEST
}

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { permissionKeys, roleKeys, userStatuses } = require('../src/utils/enums')

async function registerVerifiedAdmin(prefix = 'SaPolicy') {
  clearMemoryOutbox()
  const companyName = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
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
    companyId: register.body.data.companyId,
  })
  assert.equal(login.status, 200)
  return {
    accessToken: login.body.data.accessToken,
    companyId: register.body.data.companyId,
    userId: login.body.data.user.id,
    email,
  }
}

test('super admin policy integration: skipped without isolated DB_NAME_TEST', {
  skip: RUN,
}, () => {
  assert.equal(RUN, false)
})

test('super admin policy: empty Super Admin permissions still access new routes; Admin 403 without key', {
  skip: !RUN,
}, async () => {
  const { Role, User } = getModels()
  const admin = await registerVerifiedAdmin('SaPol')

  const superRole = await Role.findOne({
    where: { companyId: admin.companyId, key: roleKeys.superAdmin },
  })
  assert.ok(superRole)
  assert.equal(superRole.isProtected, true)

  // Simulate stale Super Admin row with no seeded keys (future modules never mapped).
  await superRole.update({ permissions: [] })

  const asSuper = await request(app)
    .get('/api/leads/import/template')
    .set('Authorization', `Bearer ${admin.accessToken}`)
  assert.equal(asSuper.status, 200, 'Super Admin must access leads.import without seeding')

  // Admin role without leads.import → 403
  const adminRole = await Role.findOne({
    where: { companyId: admin.companyId, key: roleKeys.admin },
  })
  assert.ok(adminRole)
  const withoutImport = (adminRole.permissions || []).filter((key) => key !== permissionKeys.leadsImport)
  await adminRole.update({ permissions: withoutImport })

  // Move user onto Admin role for this check
  await User.update({ roleId: adminRole.id }, { where: { id: admin.userId } })
  const reLogin = await request(app).post('/api/auth/login').send({
    email: admin.email,
    password: 'Password1!',
    companyId: admin.companyId,
  })
  assert.equal(reLogin.status, 200)

  const asAdminDenied = await request(app)
    .get('/api/leads/import/template')
    .set('Authorization', `Bearer ${reLogin.body.data.accessToken}`)
  assert.equal(asAdminDenied.status, 403)

  // Grant leads.import → allowed
  await adminRole.update({
    permissions: [...withoutImport, permissionKeys.leadsImport],
  })
  const asAdminAllowed = await request(app)
    .get('/api/leads/import/template')
    .set('Authorization', `Bearer ${reLogin.body.data.accessToken}`)
  assert.equal(asAdminAllowed.status, 200)

  // Unauthenticated blocked
  const anon = await request(app).get('/api/leads/import/template')
  assert.equal(anon.status, 401)

  // Disabled user blocked at auth
  await User.update({ status: userStatuses.disabled }, { where: { id: admin.userId } })
  const disabled = await request(app)
    .get('/api/leads/import/template')
    .set('Authorization', `Bearer ${reLogin.body.data.accessToken}`)
  assert.equal(disabled.status, 401)

  // Company isolation: other company Super Admin cannot read this company's session by id
  await User.update({ status: userStatuses.active }, { where: { id: admin.userId } })
  const other = await registerVerifiedAdmin('SaPolB')
  const foreign = await request(app)
    .get(`/api/leads/import/sessions/${admin.companyId}`)
    .set('Authorization', `Bearer ${other.accessToken}`)
  assert.ok([403, 404].includes(foreign.status))
})
