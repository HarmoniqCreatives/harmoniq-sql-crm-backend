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
const { calendarDate, isOverdue } = require('../src/services/leadOverdue')
const { allocateLeadNumber } = require('../src/services/leadCounter')
const { roleKeys, userStatuses } = require('../src/utils/enums')
const { hashPassword } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'LeadCo') {
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

async function defaultStatusId(token) {
  const statuses = await authGet(token, '/api/catalog?kind=STATUS')
  assert.equal(statuses.status, 200)
  const neu = statuses.body.data.items.find((row) => row.key === 'new')
  assert.ok(neu)
  return neu.id
}

async function defaultTagId(token, key = 'warm') {
  const tags = await authGet(token, '/api/catalog?kind=TAG')
  const tag = tags.body.data.items.find((row) => row.key === key)
  assert.ok(tag)
  return tag.id
}

async function defaultActivityId(token) {
  const activities = await authGet(token, '/api/catalog?kind=ACTIVITY')
  const activity = activities.body.data.items.find((row) => row.key === 'callback')
  assert.ok(activity)
  return activity.id
}

async function createActiveUser({ companyId, roleKey, name, branchId = null, teamId = null }) {
  const { User, Role } = getModels()
  const role = await Role.findOne({ where: { companyId, key: roleKey } })
  assert.ok(role)
  const user = await User.create({
    id: uuidv4(),
    companyId,
    roleId: role.id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@example.com`,
    phone: '+971501234567',
    passwordHash: await hashPassword('Password1!'),
    status: userStatuses.active,
    emailVerified: true,
    branchId,
    teamId,
  })
  const login = await request(app).post('/api/auth/login').send({
    email: user.email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)
  return { user, accessToken: login.body.data.accessToken, role }
}

function assertNoSecrets(payload) {
  const raw = JSON.stringify(payload)
  assert.equal(raw.includes('passwordHash'), false)
  assert.equal(raw.includes('deletedBy'), false)
  assert.equal(raw.includes('refreshToken'), false)
  assert.equal(raw.includes('verifyToken'), false)
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('lead CRUD: create, list, get, update, soft delete hides from all reads', async () => {
  const admin = await registerVerifiedAdmin('LeadCrud')
  const statusId = await defaultStatusId(admin.accessToken)
  const tagId = await defaultTagId(admin.accessToken)

  const created = await authPost(admin.accessToken, '/api/leads', {
    name: 'Aisha Khan',
    phone: '+971501111111',
    email: 'aisha@example.com',
    statusId,
    tagIds: [tagId],
    source: 'manual',
  })
  assert.equal(created.status, 201)
  // Legacy: seed counter at 1000 then $inc → first lead is 1001.
  assert.equal(created.body.data.lead.number, 1001)
  assert.equal(created.body.data.lead.label, '#1001')
  assert.equal(created.body.data.lead.currency, 'INR')
  assert.equal(created.body.data.lead.tags.length, 1)
  assertNoSecrets(created.body)

  const listed = await authGet(admin.accessToken, '/api/leads')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.data.total, 1)
  assert.equal(listed.body.data.leads[0].id, created.body.data.lead.id)

  const got = await authGet(admin.accessToken, `/api/leads/${created.body.data.lead.id}`)
  assert.equal(got.status, 200)
  assert.equal(got.body.data.lead.name, 'Aisha Khan')

  const patched = await authPatch(admin.accessToken, `/api/leads/${created.body.data.lead.id}`, {
    name: 'Aisha Updated',
    location: 'Dubai Marina',
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.data.lead.name, 'Aisha Updated')
  assert.equal(patched.body.data.lead.location, 'Dubai Marina')

  const deleted = await authDelete(admin.accessToken, `/api/leads/${created.body.data.lead.id}`)
  assert.equal(deleted.status, 200)

  const missing = await authGet(admin.accessToken, `/api/leads/${created.body.data.lead.id}`)
  assert.equal(missing.status, 404)

  const afterDelete = await authGet(admin.accessToken, '/api/leads')
  assert.equal(afterDelete.body.data.total, 0)
  assert.equal(afterDelete.body.data.leads.length, 0)

  const searchDeleted = await authGet(admin.accessToken, '/api/leads?search=Aisha')
  assert.equal(searchDeleted.body.data.total, 0)

  const next = await authPost(admin.accessToken, '/api/leads', {
    name: 'Next Lead',
    phone: '+971502222222',
    statusId,
  })
  assert.equal(next.status, 201)
  assert.equal(next.body.data.lead.number, 1002)
})

test('fresh company lead numbers: first is 1001, then 1002, 1003 (legacy parity)', async () => {
  const admin = await registerVerifiedAdmin('LeadSeq')
  const statusId = await defaultStatusId(admin.accessToken)
  const first = await authPost(admin.accessToken, '/api/leads', {
    name: 'Seq One',
    phone: '+971502300001',
    statusId,
  })
  const second = await authPost(admin.accessToken, '/api/leads', {
    name: 'Seq Two',
    phone: '+971502300002',
    statusId,
  })
  const third = await authPost(admin.accessToken, '/api/leads', {
    name: 'Seq Three',
    phone: '+971502300003',
    statusId,
  })
  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.equal(third.status, 201)
  assert.equal(first.body.data.lead.number, 1001)
  assert.equal(second.body.data.lead.number, 1002)
  assert.equal(third.body.data.lead.number, 1003)
  assert.deepEqual(
    [first, second, third].map((row) => row.body.data.lead.label),
    ['#1001', '#1002', '#1003'],
  )
})

test('search, filters, sorting, pagination bounds, invalid sort rejected', async () => {
  const admin = await registerVerifiedAdmin('LeadFilter')
  const statusId = await defaultStatusId(admin.accessToken)
  const tagWarm = await defaultTagId(admin.accessToken, 'warm')
  const tagAngry = await defaultTagId(admin.accessToken, 'angry')
  const agent = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Filter Agent',
  })

  const a = await authPost(admin.accessToken, '/api/leads', {
    name: 'Alpha Lead',
    phone: '+971503333001',
    email: 'alpha@example.com',
    statusId,
    tagIds: [tagWarm],
    primaryAgentId: agent.user.id,
    source: 'website',
  })
  const b = await authPost(admin.accessToken, '/api/leads', {
    name: 'Beta Lead',
    phone: '+971503333002',
    statusId,
    tagIds: [tagAngry],
    source: 'manual',
  })
  assert.equal(a.status, 201)
  assert.equal(b.status, 201)

  const byName = await authGet(admin.accessToken, '/api/leads?search=Alpha')
  assert.equal(byName.body.data.total, 1)
  assert.equal(byName.body.data.leads[0].name, 'Alpha Lead')

  const byNumber = await authGet(admin.accessToken, `/api/leads?search=%23${a.body.data.lead.number}`)
  assert.equal(byNumber.body.data.total, 1)

  const byTag = await authGet(admin.accessToken, `/api/leads?tagId=${tagWarm}`)
  assert.equal(byTag.body.data.total, 1)

  const byAgent = await authGet(admin.accessToken, `/api/leads?agentId=${agent.user.id}`)
  assert.equal(byAgent.body.data.total, 1)

  const bySource = await authGet(admin.accessToken, '/api/leads?source=website')
  assert.equal(bySource.body.data.total, 1)

  const sorted = await authGet(admin.accessToken, '/api/leads?sort=name&order=asc')
  assert.equal(sorted.status, 200)
  assert.ok(sorted.body.data.leads[0].name <= sorted.body.data.leads[1].name)

  const badSort = await authGet(admin.accessToken, '/api/leads?sort=passwordHash')
  assert.equal(badSort.status, 400)

  const page = await authGet(admin.accessToken, '/api/leads?page=1&limit=1')
  assert.equal(page.body.data.leads.length, 1)
  assert.equal(page.body.data.limit, 1)
  assert.equal(page.body.data.total, 2)

  const capped = await authGet(admin.accessToken, '/api/leads?limit=999')
  assert.equal(capped.body.data.limit, 50)
})

test('scope: company, branch, team, own; secondary agent visibility', async () => {
  const admin = await registerVerifiedAdmin('LeadScope')
  const { Branch, Team } = getModels()
  const branchA = await Branch.create({
    id: uuidv4(),
    companyId: admin.companyId,
    name: 'Branch A',
    nameKey: `ba-${Date.now()}`,
    isActive: true,
  })
  const branchB = await Branch.create({
    id: uuidv4(),
    companyId: admin.companyId,
    name: 'Branch B',
    nameKey: `bb-${Date.now()}`,
    isActive: true,
  })
  const teamA = await Team.create({
    id: uuidv4(),
    companyId: admin.companyId,
    branchId: branchA.id,
    name: 'Team A',
    nameKey: `ta-${Date.now()}`,
    isActive: true,
  })
  const teamB = await Team.create({
    id: uuidv4(),
    companyId: admin.companyId,
    branchId: branchB.id,
    name: 'Team B',
    nameKey: `tb-${Date.now()}`,
    isActive: true,
  })

  const primary = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Primary Agent',
    branchId: branchA.id,
    teamId: teamA.id,
  })
  const secondary = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Secondary Agent',
    branchId: branchA.id,
    teamId: teamA.id,
  })
  const otherAgent = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Other Agent',
    branchId: branchB.id,
    teamId: teamB.id,
  })
  const manager = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.manager,
    name: 'Team Manager',
    branchId: branchA.id,
    teamId: teamA.id,
  })

  const { Role } = getModels()
  const branchRole = await Role.create({
    id: uuidv4(),
    companyId: admin.companyId,
    key: `branch_mgr_${Date.now()}`,
    name: 'Branch Viewer',
    description: 'Branch scope',
    permissions: ['leads.view'],
    scope: 'BRANCH',
    isSystem: false,
    isProtected: false,
  })
  const branchViewerUser = await (async () => {
    const { User } = getModels()
    const user = await User.create({
      id: uuidv4(),
      companyId: admin.companyId,
      roleId: branchRole.id,
      name: 'Branch Viewer',
      email: `branch.viewer.${Date.now()}@example.com`,
      phone: '+971509999001',
      passwordHash: await hashPassword('Password1!'),
      status: userStatuses.active,
      emailVerified: true,
      branchId: branchA.id,
      teamId: teamA.id,
    })
    const login = await request(app).post('/api/auth/login').send({
      email: user.email,
      password: 'Password1!',
    })
    assert.equal(login.status, 200)
    return { user, accessToken: login.body.data.accessToken }
  })()

  const statusId = await defaultStatusId(admin.accessToken)
  const shared = await authPost(admin.accessToken, '/api/leads', {
    name: 'Shared Lead',
    phone: '+971504444001',
    statusId,
    primaryAgentId: primary.user.id,
    secondaryAgentId: secondary.user.id,
  })
  assert.equal(shared.status, 201)
  assert.equal(shared.body.data.lead.branchId, branchA.id)
  assert.equal(shared.body.data.lead.teamId, teamA.id)

  const otherLead = await authPost(admin.accessToken, '/api/leads', {
    name: 'Other Lead',
    phone: '+971504444002',
    statusId,
    primaryAgentId: otherAgent.user.id,
  })
  assert.equal(otherLead.status, 201)

  const adminList = await authGet(admin.accessToken, '/api/leads')
  assert.equal(adminList.body.data.total, 2)

  const primaryList = await authGet(primary.accessToken, '/api/leads')
  assert.equal(primaryList.body.data.total, 1)
  assert.equal(primaryList.body.data.leads[0].id, shared.body.data.lead.id)

  const secondaryList = await authGet(secondary.accessToken, '/api/leads')
  assert.equal(secondaryList.body.data.total, 1)
  assert.equal(secondaryList.body.data.leads[0].id, shared.body.data.lead.id)

  const otherOwn = await authGet(otherAgent.accessToken, '/api/leads')
  assert.equal(otherOwn.body.data.total, 1)
  assert.equal(otherOwn.body.data.leads[0].id, otherLead.body.data.lead.id)

  const managerList = await authGet(manager.accessToken, '/api/leads')
  assert.equal(managerList.body.data.total, 1)

  const branchList = await authGet(branchViewerUser.accessToken, '/api/leads')
  assert.equal(branchList.body.data.total, 1)

  const secondaryGet = await authGet(secondary.accessToken, `/api/leads/${shared.body.data.lead.id}`)
  assert.equal(secondaryGet.status, 200)

  const otherCannotSee = await authGet(otherAgent.accessToken, `/api/leads/${shared.body.data.lead.id}`)
  assert.equal(otherCannotSee.status, 404)
})

test('assignment requires reason; original assignee preserved across transfers', async () => {
  const admin = await registerVerifiedAdmin('LeadAssign')
  const statusId = await defaultStatusId(admin.accessToken)
  const first = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'First Agent',
  })
  const second = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Second Agent',
  })
  const third = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Third Agent',
  })

  const created = await authPost(admin.accessToken, '/api/leads', {
    name: 'Assign Lead',
    phone: '+971505555001',
    statusId,
    primaryAgentId: first.user.id,
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.lead.originalPrimaryAgent.id, first.user.id)

  const noReason = await authPatch(admin.accessToken, `/api/leads/${created.body.data.lead.id}/assignment`, {
    primaryAgentId: second.user.id,
  })
  assert.equal(noReason.status, 400)

  const transfer1 = await authPatch(admin.accessToken, `/api/leads/${created.body.data.lead.id}/assignment`, {
    primaryAgentId: second.user.id,
    reason: 'Coverage',
  })
  assert.equal(transfer1.status, 200)
  assert.equal(transfer1.body.data.lead.primaryAgent.id, second.user.id)
  assert.equal(transfer1.body.data.lead.originalPrimaryAgent.id, first.user.id)
  assert.equal(transfer1.body.data.lead.transfers.length, 1)

  const transfer2 = await authPatch(admin.accessToken, `/api/leads/${created.body.data.lead.id}/assignment`, {
    primaryAgentId: third.user.id,
    secondaryAgentId: second.user.id,
    reason: 'Escalation',
  })
  assert.equal(transfer2.status, 200)
  assert.equal(transfer2.body.data.lead.primaryAgent.id, third.user.id)
  assert.equal(transfer2.body.data.lead.originalPrimaryAgent.id, first.user.id)
  assert.equal(transfer2.body.data.lead.transfers.length, 2)
})

test('notes, feedback and activities are append-only with author/timestamps', async () => {
  const admin = await registerVerifiedAdmin('LeadAppend')
  const statusId = await defaultStatusId(admin.accessToken)
  const activityTypeId = await defaultActivityId(admin.accessToken)
  const agent = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Append Agent',
  })

  const created = await authPost(admin.accessToken, '/api/leads', {
    name: 'Append Lead',
    phone: '+971506666001',
    statusId,
    primaryAgentId: agent.user.id,
  })
  assert.equal(created.status, 201)
  const leadId = created.body.data.lead.id

  const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  const patched = await authPatch(admin.accessToken, `/api/leads/${leadId}`, {
    note: 'Called client',
    feedback: { type: 'positive', text: 'Interested in villa' },
    activity: {
      activityTypeId,
      agentId: agent.user.id,
      scheduledAt: tomorrow,
    },
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.data.lead.notes.length, 1)
  assert.equal(patched.body.data.lead.notes[0].text, 'Called client')
  assert.equal(patched.body.data.lead.notes[0].createdBy, admin.user.id)
  assert.ok(patched.body.data.lead.notes[0].createdAt)
  assert.equal(patched.body.data.lead.feedbacks.length, 1)
  assert.equal(patched.body.data.lead.feedbacks[0].type, 'positive')
  assert.equal(patched.body.data.lead.activities.length, 1)
  assert.equal(patched.body.data.lead.activities[0].agentId, agent.user.id)
  assert.ok(patched.body.data.lead.nextFollowUpAt)

  const again = await authPatch(admin.accessToken, `/api/leads/${leadId}`, {
    note: 'Second note',
    feedback: { type: 'concern', text: 'Budget concern' },
  })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.lead.notes.length, 2)
  assert.equal(again.body.data.lead.feedbacks.length, 2)
  assert.equal(again.body.data.lead.activities.length, 1)
})

test('overdue helper respects company timezone, DST and near-midnight', () => {
  const nyc = 'America/New_York'
  // 2024-03-10 05:30 UTC is still 2024-03-10 in NYC before DST jump; previous calendar day is overdue.
  assert.equal(isOverdue(new Date('2024-03-09T23:30:00.000Z'), nyc), true)
  // Same instant as "today" relative to a fixed now would require stubbing; calendarDate itself is DST-aware.
  const springForward = calendarDate(new Date('2024-03-10T06:30:00.000Z'), nyc)
  assert.equal(springForward, '2024-03-10')
  const nearMidnightDubai = calendarDate(new Date('2024-06-01T19:30:00.000Z'), 'Asia/Dubai')
  assert.equal(nearMidnightDubai, '2024-06-01')
  const afterMidnightDubai = calendarDate(new Date('2024-06-01T20:30:00.000Z'), 'Asia/Dubai')
  assert.equal(afterMidnightDubai, '2024-06-02')
  assert.equal(isOverdue(null, nyc), false)
  assert.equal(isOverdue(new Date(), ''), false)
})

test('cross-tenant catalog/user/lead IDs return 404', async () => {
  const first = await registerVerifiedAdmin('LeadTenA')
  const second = await registerVerifiedAdmin('LeadTenB')
  const statusA = await defaultStatusId(first.accessToken)
  const statusB = await defaultStatusId(second.accessToken)
  const tagB = await defaultTagId(second.accessToken)
  const agentB = await createActiveUser({
    companyId: second.companyId,
    roleKey: roleKeys.agent,
    name: 'Foreign Agent',
  })

  const foreignStatus = await authPost(first.accessToken, '/api/leads', {
    name: 'Bad Status',
    phone: '+971507777001',
    statusId: statusB,
  })
  assert.equal(foreignStatus.status, 404)

  const foreignTag = await authPost(first.accessToken, '/api/leads', {
    name: 'Bad Tag',
    phone: '+971507777002',
    statusId: statusA,
    tagIds: [tagB],
  })
  assert.equal(foreignTag.status, 404)

  const foreignAgent = await authPost(first.accessToken, '/api/leads', {
    name: 'Bad Agent',
    phone: '+971507777003',
    statusId: statusA,
    primaryAgentId: agentB.user.id,
  })
  assert.equal(foreignAgent.status, 404)

  const own = await authPost(first.accessToken, '/api/leads', {
    name: 'Own Lead',
    phone: '+971507777004',
    statusId: statusA,
  })
  assert.equal(own.status, 201)

  const crossGet = await authGet(second.accessToken, `/api/leads/${own.body.data.lead.id}`)
  assert.equal(crossGet.status, 404)

  const crossPatch = await authPatch(second.accessToken, `/api/leads/${own.body.data.lead.id}`, {
    name: 'Hijack',
  })
  assert.equal(crossPatch.status, 404)

  const crossDelete = await authDelete(second.accessToken, `/api/leads/${own.body.data.lead.id}`)
  assert.equal(crossDelete.status, 404)
})

test('concurrent lead numbers are unique and first number is 1001; soft-delete does not reuse', async () => {
  const admin = await registerVerifiedAdmin('LeadNums')
  const statusId = await defaultStatusId(admin.accessToken)
  const jobs = Array.from({ length: 20 }, (_, index) => authPost(admin.accessToken, '/api/leads', {
    name: `Concurrent ${index}`,
    phone: `+9715088${String(index).padStart(4, '0')}`,
    statusId,
  }))
  const results = await Promise.all(jobs)
  for (const result of results) {
    assert.equal(result.status, 201)
  }
  const numbers = results.map((row) => row.body.data.lead.number).sort((a, b) => a - b)
  assert.equal(numbers[0], 1001)
  assert.equal(numbers[numbers.length - 1], 1020)
  assert.equal(new Set(numbers).size, 20)
  for (let index = 1; index < numbers.length; index += 1) {
    assert.ok(numbers[index] > numbers[index - 1])
  }

  const victim = results[0].body.data.lead
  await authDelete(admin.accessToken, `/api/leads/${victim.id}`)
  const after = await authPost(admin.accessToken, '/api/leads', {
    name: 'After Soft Delete',
    phone: '+97150889999',
    statusId,
  })
  assert.equal(after.status, 201)
  assert.equal(after.body.data.lead.number, 1021)
  assert.notEqual(after.body.data.lead.number, victim.number)
})

test('duplicate metaLeadId returns 409', async () => {
  const admin = await registerVerifiedAdmin('LeadMeta')
  const statusId = await defaultStatusId(admin.accessToken)
  const first = await authPost(admin.accessToken, '/api/leads', {
    name: 'Meta One',
    phone: '+971509000001',
    statusId,
    metaLeadId: 'meta-dup-1',
  })
  assert.equal(first.status, 201)
  const dup = await authPost(admin.accessToken, '/api/leads', {
    name: 'Meta Two',
    phone: '+971509000002',
    statusId,
    metaLeadId: 'meta-dup-1',
  })
  assert.equal(dup.status, 409)

  const plainA = await authPost(admin.accessToken, '/api/leads', {
    name: 'Plain A',
    phone: '+971509000003',
    statusId,
  })
  const plainB = await authPost(admin.accessToken, '/api/leads', {
    name: 'Plain B',
    phone: '+971509000004',
    statusId,
  })
  assert.equal(plainA.status, 201)
  assert.equal(plainB.status, 201)
})

test('permissions: 401 without auth; 403 without leads permissions', async () => {
  const admin = await registerVerifiedAdmin('LeadPerm')
  const statusId = await defaultStatusId(admin.accessToken)
  const anon = await request(app).get('/api/leads')
  assert.equal(anon.status, 401)

  const agent = await createActiveUser({
    companyId: admin.companyId,
    roleKey: roleKeys.agent,
    name: 'Perm Agent',
  })
  const createDenied = await authPost(agent.accessToken, '/api/leads', {
    name: 'Denied',
    phone: '+971509111001',
    statusId,
  })
  assert.equal(createDenied.status, 403)

  const created = await authPost(admin.accessToken, '/api/leads', {
    name: 'Perm Lead',
    phone: '+971509111002',
    statusId,
    primaryAgentId: agent.user.id,
  })
  assert.equal(created.status, 201)

  const deleteDenied = await authDelete(agent.accessToken, `/api/leads/${created.body.data.lead.id}`)
  assert.equal(deleteDenied.status, 403)

  const assignDenied = await authPatch(agent.accessToken, `/api/leads/${created.body.data.lead.id}/assignment`, {
    primaryAgentId: agent.user.id,
    reason: 'Nope',
  })
  assert.equal(assignDenied.status, 403)

  const viewOk = await authGet(agent.accessToken, `/api/leads/${created.body.data.lead.id}`)
  assert.equal(viewOk.status, 200)
  assertNoSecrets(viewOk.body)
})

test('allocateLeadNumber row lock yields monotonic unique sequence', async () => {
  const admin = await registerVerifiedAdmin('LeadLock')
  const { sequelize } = getModels()
  const values = await Promise.all(
    Array.from({ length: 15 }, () => sequelize.transaction(async (transaction) => (
      allocateLeadNumber(admin.companyId, transaction)
    ))),
  )
  const sorted = [...values].sort((a, b) => a - b)
  assert.equal(sorted[0], 1001)
  assert.equal(sorted[sorted.length - 1], 1015)
  assert.equal(new Set(sorted).size, 15)
})
