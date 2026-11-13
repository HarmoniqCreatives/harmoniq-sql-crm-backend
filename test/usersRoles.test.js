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
const { permissionKeys, roleKeys } = require('../src/utils/enums')
const { hashSecret } = require('../src/utils/helpers')

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
    companyName,
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

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('lists users with pagination, search, filters and sort', async () => {
  const admin = await registerVerifiedAdmin('List')
  const roles = await authGet(admin.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  await authPost(admin.accessToken, '/api/invitations', {
    name: 'Agent One',
    email: `agent.one.${Date.now()}@example.com`,
    roleId: agentRole.id,
  })
  const listed = await authGet(admin.accessToken, '/api/users?page=1&limit=10&sort=name&direction=asc')
  assert.equal(listed.status, 200)
  assert.ok(listed.body.data.total >= 1)
  assert.ok(Array.isArray(listed.body.data.users))
  const search = await authGet(admin.accessToken, `/api/users?search=${encodeURIComponent(admin.user.name)}`)
  assert.equal(search.status, 200)
  assert.ok(search.body.data.users.some((row) => row.email === admin.email))
  const filtered = await authGet(admin.accessToken, `/api/users?roleId=${agentRole.id}`)
  assert.equal(filtered.status, 200)
  for (const row of filtered.body.data.users) {
    assert.equal(row.role.id, agentRole.id)
  }
})

test('invite create, duplicate prevention, accept single-use, resend rotates token', async () => {
  clearMemoryOutbox()
  const admin = await registerVerifiedAdmin('Invite')
  const roles = await authGet(admin.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const email = `invitee.${Date.now()}@example.com`

  const created = await authPost(admin.accessToken, '/api/invitations', {
    name: 'Invitee',
    email,
    roleId: agentRole.id,
  })
  assert.equal(created.status, 201)
  assert.ok(created.body.data.link.startsWith('https://crm.example.com/accept-invitation?token='))
  assert.equal(JSON.stringify(created.body).includes('passwordHash'), false)
  const firstToken = new URL(created.body.data.link).searchParams.get('token')
  assert.ok(firstToken)
  assert.equal(created.body.data.link.includes(firstToken), true)

  const duplicateInvite = await authPost(admin.accessToken, '/api/invitations', {
    name: 'Invitee',
    email,
    roleId: agentRole.id,
  })
  assert.equal(duplicateInvite.status, 409)

  const preview = await request(app).get('/api/invitations/accept').query({ token: firstToken })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.data.invitation.email, email)

  const resend = await authPost(admin.accessToken, `/api/invitations/${created.body.data.invitation.id}/resend`)
  assert.equal(resend.status, 200)
  const secondToken = new URL(resend.body.data.link).searchParams.get('token')
  assert.notEqual(secondToken, firstToken)

  const oldPreview = await request(app).get('/api/invitations/accept').query({ token: firstToken })
  assert.equal(oldPreview.status, 400)

  const accept = await request(app).post('/api/invitations/accept').send({
    token: secondToken,
    password: 'Password2!',
    confirmPassword: 'Password2!',
  })
  assert.equal(accept.status, 200)

  const reuse = await request(app).post('/api/invitations/accept').send({
    token: secondToken,
    password: 'Password2!',
    confirmPassword: 'Password2!',
  })
  assert.equal(reuse.status, 400)

  const duplicateUserInvite = await authPost(admin.accessToken, '/api/invitations', {
    name: 'Invitee',
    email,
    roleId: agentRole.id,
  })
  assert.equal(duplicateUserInvite.status, 409)
})

test('invite succeeds when mail fails; copy link never needs mail', async () => {
  const admin = await registerVerifiedAdmin('MailFail')
  const roles = await authGet(admin.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const previousDriver = process.env.MAIL_DRIVER
  const previousProvider = process.env.MAIL_PROVIDER
  process.env.MAIL_DRIVER = ''
  process.env.MAIL_PROVIDER = 'resend'
  delete process.env.RESEND_API_KEY

  const created = await authPost(admin.accessToken, '/api/invitations', {
    name: 'Offline Mail',
    email: `offline.${Date.now()}@example.com`,
    roleId: agentRole.id,
  })
  assert.equal(created.status, 201)
  assert.ok(created.body.data.link)

  // Wait briefly for background mail attempt to settle.
  await new Promise((resolve) => setTimeout(resolve, 50))

  const link = await authPost(admin.accessToken, `/api/invitations/${created.body.data.invitation.id}/link`)
  assert.equal(link.status, 200)
  assert.ok(link.body.data.link.startsWith('https://crm.example.com/accept-invitation?token='))
  assert.equal(link.body.data.link.includes('localhost'), false)

  process.env.MAIL_DRIVER = previousDriver
  process.env.MAIL_PROVIDER = previousProvider
})

test('roles create/edit, system protection, privilege escalation blocked', async () => {
  const admin = await registerVerifiedAdmin('Roles')
  const created = await authPost(admin.accessToken, '/api/roles', {
    name: 'Custom Closer',
    description: 'Close deals',
    permissions: [permissionKeys.leadsView, permissionKeys.leadsEdit],
  })
  assert.equal(created.status, 201)

  const escalate = await authPost(admin.accessToken, '/api/roles', {
    name: 'Too Much',
    permissions: [permissionKeys.leadsView, 'does.not.exist'],
  })
  assert.equal(escalate.status, 400)

  const roles = await authGet(admin.accessToken, '/api/roles')
  const superRole = roles.body.data.roles.find((role) => role.key === roleKeys.superAdmin)
  const deleteSuper = await request(app)
    .delete(`/api/roles/${superRole.id}`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
  assert.equal(deleteSuper.status, 403)

  const patched = await authPatch(admin.accessToken, `/api/roles/${created.body.data.role.id}`, {
    permissions: [permissionKeys.leadsView],
  })
  assert.equal(patched.status, 200)
})

test('permission enforcement returns 401/403; protected super admin cannot be demoted by others', async () => {
  const admin = await registerVerifiedAdmin('Perms')
  const unauth = await request(app).get('/api/users')
  assert.equal(unauth.status, 401)

  const { User, Role } = getModels()
  const agentRole = await Role.findOne({
    where: { companyId: admin.companyId, key: roleKeys.agent },
  })
  const agent = await User.create({
    id: uuidv4(),
    companyId: admin.companyId,
    roleId: agentRole.id,
    name: 'Limited Agent',
    email: `limited.${Date.now()}@example.com`,
    passwordHash: admin.user.id, // placeholder replaced below via login path not used
    status: 'ACTIVE',
    emailVerified: true,
  })
  // Give agent a real password through update helpers in service is heavy; use bcrypt via auth helpers.
  const { hashPassword } = require('../src/utils/helpers')
  agent.passwordHash = await hashPassword('Password1!')
  await agent.save()

  const agentLogin = await request(app).post('/api/auth/login').send({
    email: agent.email,
    password: 'Password1!',
  })
  assert.equal(agentLogin.status, 200)
  const forbidden = await authGet(agentLogin.body.data.accessToken, '/api/users')
  assert.equal(forbidden.status, 403)

  const demote = await authPatch(agentLogin.body.data.accessToken, `/api/users/${admin.user.id}`, {
    roleId: agentRole.id,
  })
  assert.equal(demote.status, 403)
})

test('branch/team assignment validates company ownership', async () => {
  const first = await registerVerifiedAdmin('BranchA')
  const second = await registerVerifiedAdmin('BranchB')
  const { Branch, Team } = getModels()
  const branch = await Branch.create({
    id: uuidv4(),
    companyId: first.companyId,
    name: 'HQ',
    nameKey: `hq-${Date.now()}`,
    isActive: true,
  })
  const team = await Team.create({
    id: uuidv4(),
    companyId: first.companyId,
    branchId: branch.id,
    name: 'Sales',
    nameKey: `sales-${Date.now()}`,
    isActive: true,
  })
  const foreignBranch = await Branch.create({
    id: uuidv4(),
    companyId: second.companyId,
    name: 'Other',
    nameKey: `other-${Date.now()}`,
    isActive: true,
  })

  const roles = await authGet(first.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const invite = await authPost(first.accessToken, '/api/invitations', {
    name: 'Branch User',
    email: `branch.user.${Date.now()}@example.com`,
    roleId: agentRole.id,
    branchId: branch.id,
    teamId: team.id,
  })
  assert.equal(invite.status, 201)

  const bad = await authPost(first.accessToken, '/api/invitations', {
    name: 'Bad Branch',
    email: `bad.branch.${Date.now()}@example.com`,
    roleId: agentRole.id,
    branchId: foreignBranch.id,
  })
  assert.equal(bad.status, 404)
})

test('cross-tenant isolation returns 404 for other company resources', async () => {
  const first = await registerVerifiedAdmin('TenantX')
  const second = await registerVerifiedAdmin('TenantY')
  const roles = await authGet(first.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const invite = await authPost(first.accessToken, '/api/invitations', {
    name: 'Secret',
    email: `secret.${Date.now()}@example.com`,
    roleId: agentRole.id,
  })
  const stolen = await authPost(second.accessToken, `/api/invitations/${invite.body.data.invitation.id}/link`)
  assert.equal(stolen.status, 404)

  const users = await authGet(second.accessToken, `/api/users/${first.user.id}`)
  assert.equal(users.status, 404)

  const roleStolen = await authGet(second.accessToken, `/api/roles/${agentRole.id}`)
  assert.equal(roleStolen.status, 404)
})

test('rate limiter uses separate buckets and returns Retry-After', async () => {
  process.env.RATE_LIMIT_TEST = '1'
  const limitedApp = require('../src/server').app
  const responses = []
  // Same ip + token prefix shares one bucket; unique tokens would never trip the limit.
  for (let index = 0; index < 25; index += 1) {
    const response = await request(limitedApp)
      .get('/api/invitations/accept')
      .query({ token: 'tok-shared-aaaaaaaa' })
      .set('X-Forwarded-For', '203.0.113.10')
    responses.push(response)
  }
  const blocked = responses.some((row) => row.status === 429)
  assert.equal(blocked, true)
  const sample = responses.find((row) => row.status === 429)
  assert.ok(sample.headers['retry-after'])

  const other = await request(limitedApp)
    .get('/api/invitations/accept')
    .query({ token: 'tok-shared-aaaaaaaa' })
    .set('X-Forwarded-For', '203.0.113.11')
  assert.notEqual(other.status, 429)
  delete process.env.RATE_LIMIT_TEST
})

test('creates user directly and admin password-reset returns one-time URL', async () => {
  const admin = await registerVerifiedAdmin('AddUser')
  const roles = await authGet(admin.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const email = `direct.${Date.now()}@example.com`
  const created = await authPost(admin.accessToken, '/api/users', {
    name: 'Direct User',
    email,
    password: 'Password1!',
    roleId: agentRole.id,
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.user.email, email)
  assert.equal(JSON.stringify(created.body).includes('passwordHash'), false)

  const reset = await authPost(admin.accessToken, `/api/users/${created.body.data.user.id}/password-reset`)
  assert.equal(reset.status, 200)
  assert.ok(reset.body.data.resetUrl.startsWith('https://crm.example.com/reset-password?token='))
  const token = new URL(reset.body.data.resetUrl).searchParams.get('token')
  const applied = await request(app).post('/api/auth/reset-password').send({
    token,
    password: 'Password9!',
    confirmPassword: 'Password9!',
  })
  assert.equal(applied.status, 200)
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password9!',
    companyId: admin.companyId,
  })
  assert.equal(login.status, 200)
})

test('invitation PATCH updates fields without rotating token', async () => {
  const admin = await registerVerifiedAdmin('InvitePatch')
  const roles = await authGet(admin.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const managerRole = roles.body.data.roles.find((role) => role.key === roleKeys.manager)
  const created = await authPost(admin.accessToken, '/api/invitations', {
    name: 'Patch Me',
    email: `patch.${Date.now()}@example.com`,
    roleId: agentRole.id,
  })
  assert.equal(created.status, 201)
  const invitationId = created.body.data.invitation.id
  const beforeToken = new URL(created.body.data.link).searchParams.get('token')

  const patched = await authPatch(admin.accessToken, `/api/invitations/${invitationId}`, {
    name: 'Patched Name',
    roleId: managerRole.id,
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.data.invitation.name, 'Patched Name')
  assert.equal(patched.body.data.invitation.role.id, managerRole.id)

  const preview = await request(app).get('/api/invitations/accept').query({ token: beforeToken })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.data.invitation.name, 'Patched Name')
})

test('public dial-countries returns DB catalog', async () => {
  const response = await request(app).get('/api/public/dial-countries')
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(response.body.data.countries))
  assert.ok(response.body.data.countries.length >= 10)
  assert.ok(response.body.data.countries.some((row) => row.name === 'India' && row.code === '+91'))
})

test('API responses never include password hashes or raw invite tokens in invitation records', async () => {
  const admin = await registerVerifiedAdmin('Secrets')
  const roles = await authGet(admin.accessToken, '/api/roles')
  const agentRole = roles.body.data.roles.find((role) => role.key === roleKeys.agent)
  const created = await authPost(admin.accessToken, '/api/invitations', {
    name: 'Safe',
    email: `safe.${Date.now()}@example.com`,
    roleId: agentRole.id,
  })
  const body = JSON.stringify(created.body)
  assert.equal(body.includes('passwordHash'), false)
  assert.equal(body.includes('tokenHash'), false)
  const users = await authGet(admin.accessToken, '/api/users')
  assert.equal(JSON.stringify(users.body).includes('passwordHash'), false)
  const token = new URL(created.body.data.link).searchParams.get('token')
  const { Invitation } = getModels()
  const row = await Invitation.findByPk(created.body.data.invitation.id)
  assert.equal(row.tokenHash, hashSecret(token))
})
