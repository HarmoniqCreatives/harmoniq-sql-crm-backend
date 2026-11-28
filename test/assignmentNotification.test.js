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
process.env.APP_BASE_URL = 'https://crm.example.com'
process.env.FRONTEND_URL = 'https://crm.example.com'
process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const assignmentNotifications = require('../src/services/assignmentNotificationService')
const mailService = require('../src/services/mailService')
const { assignLead, createLead } = require('../src/services/leadService')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const { catalogKinds, leadSources, roleKeys, userStatuses } = require('../src/utils/enums')
const { hashPassword } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'NotifyCo') {
  clearMemoryOutbox()
  assignmentNotifications.clearNotificationDedupe()
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
  const { User, Role, Company } = getModels()
  const user = await User.findByPk(login.body.data.user.id)
  const role = await Role.findByPk(user.roleId)
  const company = await Company.findByPk(user.companyId)
  return {
    email,
    companyId: user.companyId,
    accessToken: login.body.data.accessToken,
    user,
    role,
    company,
    auth: {
      userId: user.id,
      companyId: user.companyId,
      roleId: user.roleId,
      sessionId: null,
      user,
      role,
      company,
    },
  }
}

async function createActiveAgent(companyId, name) {
  const { User, Role } = getModels()
  const role = await Role.findOne({ where: { companyId, key: roleKeys.agent } })
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
  })
  return user
}

async function defaultStatusId(companyId) {
  const { CatalogItem } = getModels()
  const status = await CatalogItem.findOne({
    where: { companyId, kind: catalogKinds.status, key: 'new' },
  })
  assert.ok(status)
  return status.id
}

function stubNotify(notifyCalls) {
  const originalNotify = assignmentNotifications.notifyLeadPrimaryAssignment
  assignmentNotifications.notifyLeadPrimaryAssignment = (details) => {
    if (!assignmentNotifications.assignmentEmailEnabled()) {
      return { queued: false, reason: 'disabled' }
    }
    const kind = assignmentNotifications.resolveEmailKind(details)
    if (kind === assignmentNotifications.EMAIL_KINDS.transfer) {
      if (!assignmentNotifications.shouldNotifyTransfer(
        details.previousPrimaryAgentId,
        details.newPrimaryAgentId,
      )) {
        return { queued: false, reason: 'unchanged_or_unassigned' }
      }
    } else if (!assignmentNotifications.shouldNotifyPrimaryChange(
      details.previousPrimaryAgentId,
      details.newPrimaryAgentId,
    )) {
      return { queued: false, reason: 'unchanged_or_unassigned' }
    }
    const queued = originalNotify(details)
    if (queued.queued) {
      notifyCalls.push(details)
    }
    return queued
  }
  return originalNotify
}

before(() => {
  process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'
})

test('shouldNotifyPrimaryChange and shouldNotifyTransfer gates', () => {
  assert.equal(assignmentNotifications.shouldNotifyPrimaryChange(null, null), false)
  assert.equal(assignmentNotifications.shouldNotifyPrimaryChange('a', null), false)
  assert.equal(assignmentNotifications.shouldNotifyPrimaryChange('a', 'a'), false)
  assert.equal(assignmentNotifications.shouldNotifyPrimaryChange(null, 'b'), true)
  assert.equal(assignmentNotifications.shouldNotifyPrimaryChange('a', 'b'), true)
  assert.equal(assignmentNotifications.shouldNotifyTransfer(null, 'b'), false)
  assert.equal(assignmentNotifications.shouldNotifyTransfer('a', null), false)
  assert.equal(assignmentNotifications.shouldNotifyTransfer('a', 'a'), false)
  assert.equal(assignmentNotifications.shouldNotifyTransfer('a', 'b'), true)
  assert.equal(
    assignmentNotifications.resolveAssignmentEmailSubject('new_lead'),
    assignmentNotifications.ASSIGNMENT_EMAIL_SUBJECTS.new_lead,
  )
  assert.equal(
    assignmentNotifications.resolveAssignmentEmailSubject('transfer'),
    assignmentNotifications.ASSIGNMENT_EMAIL_SUBJECTS.transfer,
  )
})

test('deliverLeadAssignmentEmail sends to the new agent and respects tenant isolation', async () => {
  const adminA = await registerVerifiedAdmin('TenantA')
  const adminB = await registerVerifiedAdmin('TenantB')
  const agentA = await createActiveAgent(adminA.companyId, 'Agent A')
  const agentB = await createActiveAgent(adminB.companyId, 'Agent B')

  const calls = []
  const result = await assignmentNotifications.deliverLeadAssignmentEmail({
    companyId: adminA.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: agentA.id,
    assignedByName: 'Meta Integration',
    contactName: 'Contact One',
    contactNumber: '+971501111111',
    emailKind: assignmentNotifications.EMAIL_KINDS.newLead,
  }, async (details) => {
    calls.push(details)
  })
  assert.equal(result.sent, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].to, agentA.email)
  assert.equal(calls[0].subject, assignmentNotifications.ASSIGNMENT_EMAIL_SUBJECTS.new_lead)

  const cross = await assignmentNotifications.deliverLeadAssignmentEmail({
    companyId: adminA.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: agentB.id,
    assignedByName: 'Admin',
    contactName: 'Cross',
    contactNumber: '+971501111112',
    emailKind: assignmentNotifications.EMAIL_KINDS.newLead,
  }, async (details) => {
    calls.push(details)
  })
  assert.equal(cross.sent, false)
  assert.equal(cross.reason, 'agent_unavailable')
  assert.equal(calls.length, 1)
})

test('manual create, Meta create path, transfer A→B, same agent, null→A, no primary, fail-soft, dedupe', async () => {
  const previousEnabled = process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED
  process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'
  assignmentNotifications.clearNotificationDedupe()
  const notifyCalls = []
  const originalNotify = stubNotify(notifyCalls)

  try {
    const admin = await registerVerifiedAdmin('AssignMail')
    const first = await createActiveAgent(admin.companyId, 'First Agent')
    const second = await createActiveAgent(admin.companyId, 'Second Agent')
    const statusId = await defaultStatusId(admin.companyId)

    // Manual create with primary → new_lead
    const created = await createLead(admin.auth, {
      name: 'Created Lead',
      phone: '+971505555501',
      source: leadSources.manual,
      statusId,
      primaryAgentId: first.id,
    })
    assert.equal(notifyCalls.length, 1)
    assert.equal(notifyCalls[0].emailKind, assignmentNotifications.EMAIL_KINDS.newLead)
    assert.equal(String(notifyCalls[0].newPrimaryAgentId), String(first.id))
    assert.equal(notifyCalls[0].assignedByName, 'Admin User')
    assert.equal(String(created.lead.primaryAgent.id), String(first.id))

    // No primary → no email
    const unassigned = await createLead(admin.auth, {
      name: 'Unassigned Lead',
      phone: '+971505555502',
      source: leadSources.manual,
      statusId,
    })
    assert.equal(notifyCalls.length, 1)
    assert.equal(unassigned.lead.primaryAgent, null)

    // Meta shared createLead path (metaLeadId + facebook + primary) → one new_lead
    const metaLeadId = `meta-${Date.now()}`
    await createLead(admin.auth, {
      name: 'Meta Lead',
      phone: '+971505555503',
      source: leadSources.facebook,
      statusId,
      primaryAgentId: first.id,
      metaLeadId,
    })
    assert.equal(notifyCalls.length, 2)
    assert.equal(notifyCalls[1].emailKind, assignmentNotifications.EMAIL_KINDS.newLead)
    assert.equal(notifyCalls[1].assignedByName, assignmentNotifications.META_ASSIGNED_BY)

    // Duplicate Meta createLead (same metaLeadId) → conflict, no extra notify
    await assert.rejects(
      () => createLead(admin.auth, {
        name: 'Meta Lead Dup',
        phone: '+971505555504',
        source: leadSources.facebook,
        statusId,
        primaryAgentId: first.id,
        metaLeadId,
      }),
      (error) => error.statusCode === 409,
    )
    assert.equal(notifyCalls.length, 2)

    // Duplicate notify for same lead/kind/agents → dedupe
    const dup = assignmentNotifications.notifyLeadPrimaryAssignment({
      companyId: admin.companyId,
      leadId: created.lead.id,
      previousPrimaryAgentId: null,
      newPrimaryAgentId: first.id,
      assignedByName: 'Admin User',
      contactName: 'Created Lead',
      contactNumber: '+971505555501',
      emailKind: assignmentNotifications.EMAIL_KINDS.newLead,
    })
    // First create already claimed this key via stub → originalNotify; re-call same key
    assert.equal(dup.queued, false)
    assert.equal(dup.reason, 'duplicate')
    assert.equal(notifyCalls.length, 2)

    // Transfer A → B
    await assignLead(admin.auth, created.lead.id, {
      primaryAgentId: second.id,
      reason: 'Move to second',
    })
    assert.equal(notifyCalls.length, 3)
    assert.equal(notifyCalls[2].emailKind, assignmentNotifications.EMAIL_KINDS.transfer)
    assert.equal(String(notifyCalls[2].newPrimaryAgentId), String(second.id))
    assert.equal(String(notifyCalls[2].previousPrimaryAgentId), String(first.id))
    assert.equal(notifyCalls[2].transferReason, 'Move to second')

    // Same agent → rejected at assignLead (no transfer email)
    await assert.rejects(
      () => assignLead(admin.auth, created.lead.id, {
        primaryAgentId: second.id,
        reason: 'Same agent again',
      }),
      (error) => error.statusCode === 400,
    )
    assert.equal(notifyCalls.length, 3)

    // null → A via assignLead → no transfer email
    await assignLead(admin.auth, unassigned.lead.id, {
      primaryAgentId: first.id,
      reason: 'First assign of unassigned lead',
    })
    assert.equal(notifyCalls.length, 3)

    // Notify throw does not roll back transfer
    assignmentNotifications.notifyLeadPrimaryAssignment = () => {
      throw new Error('notify boom')
    }
    const row = await assignLead(admin.auth, created.lead.id, {
      primaryAgentId: first.id,
      reason: 'Back to first despite notify throw',
    })
    assert.equal(String(row.lead.primaryAgent.id), String(first.id))

    // Provider failure does not break create
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
    assignmentNotifications.clearNotificationDedupe()
    const failingMailer = async () => {
      throw new Error('smtp down')
    }
    const delivered = await assignmentNotifications.deliverLeadAssignmentEmail({
      companyId: admin.companyId,
      leadId: uuidv4(),
      previousPrimaryAgentId: null,
      newPrimaryAgentId: first.id,
      assignedByName: 'Admin',
      contactName: 'Soft Fail',
      contactNumber: '+971505555599',
      emailKind: assignmentNotifications.EMAIL_KINDS.newLead,
    }, failingMailer)
    assert.equal(delivered.sent, false)
    assert.equal(delivered.reason, 'send_failed')

    const softCreate = await createLead(admin.auth, {
      name: 'Soft Create',
      phone: '+971505555598',
      source: leadSources.manual,
      statusId,
      primaryAgentId: first.id,
    })
    assert.ok(softCreate.lead.id)
  } finally {
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
    if (previousEnabled === undefined) {
      delete process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED
    } else {
      process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = previousEnabled
    }
  }
})

test('kill switch suppresses New Lead and Transfer queue', async () => {
  const previousEnabled = process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED
  process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '0'
  assignmentNotifications.clearNotificationDedupe()
  const notifyCalls = []
  const originalNotify = stubNotify(notifyCalls)

  try {
    const admin = await registerVerifiedAdmin('KillMail')
    const first = await createActiveAgent(admin.companyId, 'Kill First')
    const second = await createActiveAgent(admin.companyId, 'Kill Second')
    const statusId = await defaultStatusId(admin.companyId)

    const created = await createLead(admin.auth, {
      name: 'Kill Lead',
      phone: '+971505555510',
      source: leadSources.manual,
      statusId,
      primaryAgentId: first.id,
    })
    assert.equal(notifyCalls.length, 0)

    await assignLead(admin.auth, created.lead.id, {
      primaryAgentId: second.id,
      reason: 'Should not email when disabled',
    })
    assert.equal(notifyCalls.length, 0)
  } finally {
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
    if (previousEnabled === undefined) {
      delete process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED
    } else {
      process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = previousEnabled
    }
  }
})

test('sendAssignmentEmail subjects for new_lead and transfer via memory provider', async () => {
  clearMemoryOutbox()
  process.env.MAIL_DRIVER = 'memory'
  await mailService.sendAssignmentEmail({
    to: 'agent@example.com',
    assignedBy: 'Admin',
    contactName: 'Lead One',
    contactNumber: '+971500000001',
    emailKind: 'new_lead',
  })
  await mailService.sendAssignmentEmail({
    to: 'agent@example.com',
    assignedBy: 'Admin',
    contactName: 'Lead Two',
    contactNumber: '+971500000002',
    emailKind: 'transfer',
    previousAgentName: 'Old Agent',
    transferReason: 'Coverage',
  })
  const outbox = getMemoryOutbox()
  const assignmentMails = outbox.filter((row) => row.subject && row.subject.includes('Lead'))
  assert.ok(assignmentMails.length >= 2)
  const newest = assignmentMails.slice(-2)
  assert.equal(newest[0].subject, mailService.DEFAULT_NEW_LEAD_SUBJECT)
  assert.equal(newest[1].subject, mailService.DEFAULT_TRANSFER_SUBJECT)
  assert.match(newest[1].text, /Transfer Reason: Coverage/)
  assert.match(newest[1].text, /Previous Agent: Old Agent/)
})
