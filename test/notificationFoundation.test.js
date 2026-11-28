'use strict'

/**
 * Phase 0 — in-app notification foundation.
 * Unit tests run without MySQL. Integration tests require the notifications
 * migration on an isolated test DB (DB_NAME_TEST) and skip otherwise.
 */


const {
  isolatedTestDbConfigured,
  applyIsolatedTestDbEnv,
} = require('./helpers/isolatedTestDb')
const RUN_ISOLATED_DB = isolatedTestDbConfigured()
if (RUN_ISOLATED_DB) {
  applyIsolatedTestDbEnv()
}

const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')

process.env.MAIL_DRIVER = process.env.MAIL_DRIVER || 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://crm.example.com'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://crm.example.com'
process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'
process.env.WHATSAPP_OUTBOX_AUTORUN = '0'

const inAppNotifications = require('../src/services/notificationService')
const assignmentNotifications = require('../src/services/assignmentNotificationService')
const {
  catalogKinds,
  leadSources,
  notificationCategories,
  roleKeys,
  userStatuses,
} = require('../src/utils/enums')
const { AppError, errors } = require('../src/utils/errors')
const { hashPassword } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}


async function notificationsTableReady(getModels) {
  const { sequelize } = getModels()
  try {
    await sequelize.query('SELECT 1 FROM notifications LIMIT 1')
    return true
  } catch (_error) {
    return false
  }
}

before(() => {
  process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'
})

test('idempotency keys and safe payload helpers', () => {
  const assigned = inAppNotifications.buildLeadAssignedIdempotencyKey({
    companyId: 'co-1',
    leadId: 'lead-1',
    primaryAgentId: 'agent-1',
  })
  assert.equal(assigned, 'lead_assigned:co-1:lead-1:agent-1')

  const transferred = inAppNotifications.buildLeadTransferredIdempotencyKey({
    companyId: 'co-1',
    leadId: 'lead-1',
    transferId: 'xfer-1',
    primaryAgentId: 'agent-2',
  })
  assert.equal(transferred, 'lead_transferred:co-1:lead-1:xfer-1:agent-2')

  const data = inAppNotifications.buildLeadNotificationData({
    leadId: 'lead-1',
    leadLabel: 'Contact One',
  })
  assert.equal(data.leadId, 'lead-1')
  assert.equal(data.href, '/leads/lead-1')
  assert.equal(data.leadLabel, 'Contact One')
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'phone'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'email'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'contactNumber'), false)

  assert.ok(inAppNotifications.ALLOWED_CATEGORIES.has(notificationCategories.leadAssigned))
  assert.ok(inAppNotifications.ALLOWED_CATEGORIES.has(notificationCategories.leadTransferred))
  assert.ok(inAppNotifications.ALLOWED_CATEGORIES.has(notificationCategories.followUp))
  assert.ok(inAppNotifications.ALLOWED_CATEGORIES.has(notificationCategories.leadActivity))
  assert.ok(inAppNotifications.ALLOWED_CATEGORIES.has(notificationCategories.systemAlert))
})

test('notifyLeadAssigned / notifyLeadTransferred skip gates (no DB write)', async () => {
  const noAgent = await inAppNotifications.notifyLeadAssigned({
    companyId: 'co-1',
    leadId: 'lead-1',
    newPrimaryAgentId: null,
    contactName: 'X',
  })
  assert.equal(noAgent.skipped, true)
  assert.equal(noAgent.reason, 'no_primary_agent')

  const invalid = await inAppNotifications.notifyLeadAssigned({
    companyId: '',
    leadId: 'lead-1',
    newPrimaryAgentId: 'agent-1',
    contactName: 'X',
  })
  assert.equal(invalid.skipped, true)
  assert.equal(invalid.reason, 'invalid_input')

  const unchanged = await inAppNotifications.notifyLeadTransferred({
    companyId: 'co-1',
    leadId: 'lead-1',
    previousPrimaryAgentId: 'a',
    newPrimaryAgentId: 'a',
    transferId: 't1',
    contactName: 'X',
  })
  assert.equal(unchanged.skipped, true)
  assert.equal(unchanged.reason, 'unchanged_primary')

  const notTransfer = await inAppNotifications.notifyLeadTransferred({
    companyId: 'co-1',
    leadId: 'lead-1',
    previousPrimaryAgentId: null,
    newPrimaryAgentId: 'b',
    transferId: 't1',
    contactName: 'X',
  })
  assert.equal(notTransfer.skipped, true)
  assert.equal(notTransfer.reason, 'not_a_to_b_transfer')

  const soft = await inAppNotifications.safeNotify(async () => {
    throw new Error('boom')
  }, {})
  assert.equal(soft.skipped, true)
  assert.equal(soft.reason, 'notify_failed')
})

test('create/transfer in-app notifications, idempotency, tenant isolation, email unaffected', async (t) => {
  if (!isolatedTestDbConfigured()) {
    t.skip('No isolated DB_NAME_TEST configured — skipping DB-backed notification tests')
    return
  }

  // Lazy-load so unit tests above never open a Sequelize pool against the app DB.
  process.env.DB_NAME = process.env.DB_NAME_TEST
  const request = require('supertest')
  const { app } = require('../src/server')
  const { getModels } = require('../src/models')
  const { assignLead, createLead } = require('../src/services/leadService')
  const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')

  const ready = await notificationsTableReady(getModels)
  if (!ready) {
    t.skip('notifications table not present on isolated test DB — migrate test DB first')
    return
  }

  async function registerVerifiedAdmin(prefix = 'InAppNotify') {
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
      companyId: user.companyId,
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
    return User.create({
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
  }

  async function defaultStatusId(companyId) {
    const { CatalogItem } = getModels()
    const status = await CatalogItem.findOne({
      where: { companyId, kind: catalogKinds.status, key: 'new' },
    })
    assert.ok(status)
    return status.id
  }

  async function countNotifications(where) {
    const { Notification } = getModels()
    return Notification.count({ where })
  }

  async function listNotifications(where) {
    const { Notification } = getModels()
    return Notification.findAll({ where, order: [['createdAt', 'ASC']] })
  }

  const emailCalls = []
  const originalNotify = assignmentNotifications.notifyLeadPrimaryAssignment
  assignmentNotifications.notifyLeadPrimaryAssignment = (details) => {
    const queued = originalNotify(details)
    if (queued.queued) {
      emailCalls.push(details)
    }
    return queued
  }

  try {
    const admin = await registerVerifiedAdmin('InAppA')
    const other = await registerVerifiedAdmin('InAppB')
    const first = await createActiveAgent(admin.companyId, 'First Agent')
    const second = await createActiveAgent(admin.companyId, 'Second Agent')
    const foreignAgent = await createActiveAgent(other.companyId, 'Foreign Agent')
    const statusId = await defaultStatusId(admin.companyId)

    const created = await createLead(admin.auth, {
      name: 'Created Lead',
      phone: '+971505555601',
      source: leadSources.manual,
      statusId,
      primaryAgentId: first.id,
    })
    assert.equal(emailCalls.length, 1)
    assert.equal(emailCalls[0].emailKind, assignmentNotifications.EMAIL_KINDS.newLead)

    let rows = await listNotifications({
      companyId: admin.companyId,
      entityId: created.lead.id,
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].category, notificationCategories.leadAssigned)
    assert.equal(String(rows[0].userId), String(first.id))
    assert.equal(rows[0].title, 'New lead assigned')
    assert.ok(rows[0].data)
    assert.equal(rows[0].data.leadId, created.lead.id)
    assert.equal(Object.prototype.hasOwnProperty.call(rows[0].data, 'phone'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(rows[0].data, 'email'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(rows[0].data, 'contactNumber'), false)

    const unassigned = await createLead(admin.auth, {
      name: 'Unassigned Lead',
      phone: '+971505555602',
      source: leadSources.manual,
      statusId,
    })
    assert.equal(
      await countNotifications({ companyId: admin.companyId, entityId: unassigned.lead.id }),
      0,
    )

    const metaLeadId = `meta-inapp-${Date.now()}`
    const meta = await createLead(admin.auth, {
      name: 'Meta Lead',
      phone: '+971505555603',
      source: leadSources.facebook,
      statusId,
      primaryAgentId: first.id,
      metaLeadId,
    })
    rows = await listNotifications({
      companyId: admin.companyId,
      entityId: meta.lead.id,
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].category, notificationCategories.leadAssigned)
    assert.equal(String(rows[0].userId), String(first.id))
    assert.equal(emailCalls.length, 2)

    const again = await inAppNotifications.notifyLeadAssigned({
      companyId: admin.companyId,
      leadId: created.lead.id,
      newPrimaryAgentId: first.id,
      contactName: 'Created Lead',
    })
    assert.equal(again.created, false)
    assert.equal(again.duplicate, true)
    assert.equal(
      await countNotifications({ companyId: admin.companyId, entityId: created.lead.id }),
      1,
    )

    await assignLead(admin.auth, created.lead.id, {
      primaryAgentId: second.id,
      reason: 'Move to second',
    })
    rows = await listNotifications({
      companyId: admin.companyId,
      entityId: created.lead.id,
    })
    assert.equal(rows.length, 2)
    const transferRow = rows.find((row) => row.category === notificationCategories.leadTransferred)
    assert.ok(transferRow)
    assert.equal(String(transferRow.userId), String(second.id))
    const previousAgentRows = rows.filter((row) => String(row.userId) === String(first.id))
    assert.equal(previousAgentRows.length, 1)
    assert.equal(previousAgentRows[0].category, notificationCategories.leadAssigned)
    assert.equal(emailCalls.length, 3)
    assert.equal(emailCalls[2].emailKind, assignmentNotifications.EMAIL_KINDS.transfer)

    await assert.rejects(
      () => assignLead(admin.auth, created.lead.id, {
        primaryAgentId: second.id,
        reason: 'Same agent again',
      }),
      (error) => error.statusCode === 400,
    )
    assert.equal(
      await countNotifications({ companyId: admin.companyId, entityId: created.lead.id }),
      2,
    )

    await assignLead(admin.auth, unassigned.lead.id, {
      primaryAgentId: first.id,
      reason: 'First assign',
    })
    rows = await listNotifications({
      companyId: admin.companyId,
      entityId: unassigned.lead.id,
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].category, notificationCategories.leadAssigned)
    assert.equal(String(rows[0].userId), String(first.id))

    await assert.rejects(
      () => inAppNotifications.createNotification({
        companyId: admin.companyId,
        userId: foreignAgent.id,
        category: notificationCategories.systemAlert,
        title: 'Cross',
        body: 'Should fail',
        idempotencyKey: `cross:${uuidv4()}`,
      }),
      (error) => error instanceof AppError
        && error.message === errors.notificationRecipientInvalid,
    )
  } finally {
    assignmentNotifications.notifyLeadPrimaryAssignment = originalNotify
  }
})
