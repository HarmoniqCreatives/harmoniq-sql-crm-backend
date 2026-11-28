const {
  isolatedTestDbConfigured,
  applyIsolatedTestDbEnv,
  assertIsolatedTestDbOrThrow,
} = require('./helpers/isolatedTestDb')
assertIsolatedTestDbOrThrow()
applyIsolatedTestDbEnv()

const assert = require('node:assert/strict')
const { after, before, beforeEach, test } = require('node:test')
const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = 'https://crm.example.com'
process.env.FRONTEND_URL = 'https://crm.example.com'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex')
process.env.WHATSAPP_OUTBOX_AUTORUN = '0'
process.env.WHATSAPP_GRAPH_API_VERSION = 'v27.0'
process.env.WHATSAPP_APP_ID = 'wa-app-111'
process.env.WHATSAPP_APP_SECRET = 'wa-app-secret-222'
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'wa-verify-token'
process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const assignmentNotifications = require('../src/services/assignmentNotificationService')
const {
  deliverLeadPrimaryWhatsApp,
  buildMetaAssignIdempotencyKey,
  buildTransferIdempotencyKey,
  mapBodyVariableKeys,
  buildAssignmentContext,
} = require('../src/services/whatsappAssignmentNotificationService')
const { upsertConnectedConfigForTests } = require('../src/services/whatsappConfigService')
const { assignLead, createLead } = require('../src/services/leadService')
const {
  catalogKinds,
  leadSources,
  roleKeys,
  userStatuses,
  whatsappPhoneRegistrationStatuses,
  whatsappWorkflowKeys,
  whatsappOutboxStatuses,
} = require('../src/utils/enums')
const { messages } = require('../src/utils/messages')
const { hashPassword } = require('../src/utils/helpers')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'WaW12') {
  clearMemoryOutbox()
  assignmentNotifications.clearNotificationDedupe()
  const email = `wa.w12.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName: uniqueName(prefix),
    adminName: 'WA W12 Admin',
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
  const { User, Role, Company } = getModels()
  const user = await User.findByPk(login.body.data.user.id)
  const role = await Role.findByPk(user.roleId)
  const company = await Company.findByPk(user.companyId)
  return {
    token: login.body.data.accessToken,
    companyId: user.companyId,
    userId: user.id,
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

async function createActiveAgent(companyId, name, phone = '+971501234567') {
  const { User, Role } = getModels()
  const role = await Role.findOne({ where: { companyId, key: roleKeys.agent } })
  assert.ok(role)
  return User.create({
    id: uuidv4(),
    companyId,
    roleId: role.id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@example.com`,
    phone,
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

async function connectRegisteredWhatsApp(admin, flags = {}) {
  const wabaId = flags.wabaId || `waba-${uuidv4().slice(0, 8)}`
  const phoneNumberId = flags.phoneNumberId || `phone-${uuidv4().slice(0, 8)}`
  await upsertConnectedConfigForTests({
    companyId: admin.companyId,
    userId: admin.userId,
  }, {
    wabaId,
    phoneNumberId,
    accessToken: 'EAA-wa-assignment-token',
  })
  const { WhatsAppCompanyConfig } = getModels()
  await WhatsAppCompanyConfig.update({
    phoneRegistrationStatus: whatsappPhoneRegistrationStatuses.registered,
    phoneRegisteredAt: new Date(),
    metaAssignEnabled: flags.metaAssignEnabled !== false,
    transferEnabled: flags.transferEnabled !== false,
    isActive: flags.isActive !== false,
  }, { where: { companyId: admin.companyId } })
  return { wabaId, phoneNumberId }
}

async function seedWorkflowTemplate(companyId, wabaId, workflowKey, extras = {}) {
  const { WhatsAppTemplate, WhatsAppWorkflowBinding } = getModels()
  const bodyVariableKeys = extras.bodyVariableKeys || ['leadName', 'leadPhone', 'agentName']
  const components = Object.prototype.hasOwnProperty.call(extras, 'components')
    ? extras.components
    : [{
      type: 'BODY',
      text: bodyVariableKeys.map((_, index) => `{{${index + 1}}}`).join(' '),
    }]
  const template = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId,
    wabaId,
    name: extras.name || `${workflowKey}_notice`,
    language: extras.language || 'en_US',
    category: 'UTILITY',
    status: extras.status || messages.whatsappApprovedTemplateStatus,
    components,
    bodyVariableKeys,
    isEnabled: extras.isEnabled !== false,
    lastSyncedAt: new Date(),
  })
  if (extras.bind !== false) {
    await WhatsAppWorkflowBinding.create({
      id: uuidv4(),
      companyId,
      workflowKey,
      templateId: template.id,
    })
  }
  return template
}

async function countOutbox(companyId, workflowKey) {
  const { WhatsAppOutbox } = getModels()
  return WhatsAppOutbox.count({
    where: { companyId, workflowKey },
  })
}

async function listOutbox(companyId, workflowKey) {
  const { WhatsAppOutbox } = getModels()
  return WhatsAppOutbox.findAll({
    where: { companyId, workflowKey },
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
  })
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

beforeEach(() => {
  assignmentNotifications.clearNotificationDedupe()
  process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'
})

after(() => {
  process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '1'
})

test('mapBodyVariableKeys maps known keys and fails closed on unknown keys', () => {
  const context = buildAssignmentContext({
    leadSnapshot: { name: 'Lead', phone: '+15551212', campaignName: 'Camp', facebookPageName: 'Page' },
    leadId: 'lead-1',
    agent: { name: 'Agent', phone: '+971501234567' },
  })
  const ok = mapBodyVariableKeys(['leadName', 'agentName'], context)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.parameters, ['Lead', 'Agent'])

  const bad = mapBodyVariableKeys(['leadName', 'unknownKey'], context)
  assert.equal(bad.ok, false)
  assert.equal(bad.missingKey, 'unknownKey')
})

test('W1: manual and Meta new-lead assignment enqueue once to primary agent only', async () => {
  const admin = await registerVerifiedAdmin('WaW1Ok')
  const agent = await createActiveAgent(admin.companyId, 'Primary Agent', '+971509990001')
  const statusId = await defaultStatusId(admin.companyId)
  const { wabaId } = await connectRegisteredWhatsApp(admin)
  await seedWorkflowTemplate(admin.companyId, wabaId, whatsappWorkflowKeys.metaAssign)

  const created = await createLead(admin.auth, {
    name: 'Manual Assigned',
    phone: '+971505555601',
    source: leadSources.manual,
    statusId,
    primaryAgentId: agent.id,
  })
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign), 1)
  const rows = await listOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign)
  assert.equal(rows[0].recipientPhone, '+971509990001')
  assert.equal(rows[0].recipientType, 'primary_agent')
  assert.equal(rows[0].status, whatsappOutboxStatuses.queued)
  assert.equal(
    rows[0].idempotencyKey,
    buildMetaAssignIdempotencyKey({
      companyId: admin.companyId,
      leadId: created.lead.id,
      primaryAgentId: agent.id,
    }),
  )

  const metaLeadId = `meta-w1-${Date.now()}`
  const meta = await createLead(admin.auth, {
    name: 'Meta Assigned',
    phone: '+971505555602',
    source: leadSources.facebook,
    statusId,
    primaryAgentId: agent.id,
    metaLeadId,
    campaignName: 'Spring',
    facebookPageName: 'Demo Page',
  })
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign), 2)
  assert.ok(meta.lead.id)

  // Duplicate logical W1 event is idempotent
  const again = await deliverLeadPrimaryWhatsApp({
    companyId: admin.companyId,
    leadId: created.lead.id,
    previousPrimaryAgentId: null,
    newPrimaryAgentId: agent.id,
    actorUserId: admin.userId,
    contactName: 'Manual Assigned',
    contactNumber: '+971505555601',
    workflowKey: whatsappWorkflowKeys.metaAssign,
    idempotencyKey: buildMetaAssignIdempotencyKey({
      companyId: admin.companyId,
      leadId: created.lead.id,
      primaryAgentId: agent.id,
    }),
  })
  assert.equal(again.queued, true)
  assert.equal(again.reason, 'idempotent')
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign), 2)
})

test('W1 skips: unassigned, missing phone, inactive agent, cross-company, disabled, missing template', async () => {
  const admin = await registerVerifiedAdmin('WaW1Skip')
  const other = await registerVerifiedAdmin('WaW1Other')
  const agent = await createActiveAgent(admin.companyId, 'Skip Agent', '+971509990002')
  const noPhone = await createActiveAgent(admin.companyId, 'No Phone', '')
  const inactive = await createActiveAgent(admin.companyId, 'Inactive Agent', '+971509990003')
  const { User } = getModels()
  await User.update({ status: userStatuses.disabled }, { where: { id: inactive.id } })
  const foreign = await createActiveAgent(other.companyId, 'Foreign Agent', '+971509990004')
  const statusId = await defaultStatusId(admin.companyId)
  const { wabaId } = await connectRegisteredWhatsApp(admin)
  await seedWorkflowTemplate(admin.companyId, wabaId, whatsappWorkflowKeys.metaAssign)

  await createLead(admin.auth, {
    name: 'Unassigned',
    phone: '+971505555701',
    source: leadSources.manual,
    statusId,
  })
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign), 0)

  await createLead(admin.auth, {
    name: 'No Phone Lead',
    phone: '+971505555702',
    source: leadSources.manual,
    statusId,
    primaryAgentId: noPhone.id,
  })
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign), 0)

  const inactiveResult = await deliverLeadPrimaryWhatsApp({
    companyId: admin.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: inactive.id,
    actorUserId: admin.userId,
    contactName: 'X',
    contactNumber: '+971505555703',
    workflowKey: whatsappWorkflowKeys.metaAssign,
  })
  assert.equal(inactiveResult.reason, 'agent_unavailable')

  const cross = await deliverLeadPrimaryWhatsApp({
    companyId: admin.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: foreign.id,
    actorUserId: admin.userId,
    contactName: 'X',
    contactNumber: '+971505555704',
    workflowKey: whatsappWorkflowKeys.metaAssign,
  })
  assert.equal(cross.reason, 'agent_unavailable')

  const { WhatsAppCompanyConfig } = getModels()
  await WhatsAppCompanyConfig.update({
    metaAssignEnabled: false,
  }, { where: { companyId: admin.companyId } })
  const disabled = await deliverLeadPrimaryWhatsApp({
    companyId: admin.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: agent.id,
    actorUserId: admin.userId,
    contactName: 'X',
    contactNumber: '+971505555705',
    workflowKey: whatsappWorkflowKeys.metaAssign,
  })
  assert.equal(disabled.reason, 'workflow_disabled')

  await WhatsAppCompanyConfig.update({
    metaAssignEnabled: true,
    isActive: false,
  }, { where: { companyId: admin.companyId } })
  const inactiveWa = await deliverLeadPrimaryWhatsApp({
    companyId: admin.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: agent.id,
    actorUserId: admin.userId,
    contactName: 'X',
    contactNumber: '+971505555706',
    workflowKey: whatsappWorkflowKeys.metaAssign,
  })
  assert.equal(inactiveWa.reason, 'whatsapp_not_ready')

  const adminB = await registerVerifiedAdmin('WaW1NoTpl')
  const agentB = await createActiveAgent(adminB.companyId, 'Agent B', '+971509990005')
  await connectRegisteredWhatsApp(adminB)
  // No binding/template
  const missing = await deliverLeadPrimaryWhatsApp({
    companyId: adminB.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: agentB.id,
    actorUserId: adminB.userId,
    contactName: 'X',
    contactNumber: '+971505555707',
    workflowKey: whatsappWorkflowKeys.metaAssign,
  })
  assert.equal(missing.reason, 'binding_missing')

  const { wabaId: wabaC } = await connectRegisteredWhatsApp(adminB, {
    wabaId: `waba-c-${uuidv4().slice(0, 6)}`,
    phoneNumberId: `phone-c-${uuidv4().slice(0, 6)}`,
  })
  await seedWorkflowTemplate(adminB.companyId, wabaC, whatsappWorkflowKeys.metaAssign, {
    status: 'PENDING',
    name: 'pending_only',
  })
  // Pending template bound — treat as not approved
  const pending = await deliverLeadPrimaryWhatsApp({
    companyId: adminB.companyId,
    leadId: uuidv4(),
    previousPrimaryAgentId: null,
    newPrimaryAgentId: agentB.id,
    actorUserId: adminB.userId,
    contactName: 'X',
    contactNumber: '+971505555708',
    workflowKey: whatsappWorkflowKeys.metaAssign,
  })
  assert.equal(pending.reason, 'template_not_approved')
})

test('W2: transferId idempotency — A→B, B→C, C→A, A→B again; retry and failed transfer', async () => {
  const admin = await registerVerifiedAdmin('WaW2Ok')
  const agentA = await createActiveAgent(admin.companyId, 'Agent A', '+971509880001')
  const agentB = await createActiveAgent(admin.companyId, 'Agent B', '+971509880002')
  const agentC = await createActiveAgent(admin.companyId, 'Agent C', '+971509880003')
  const statusId = await defaultStatusId(admin.companyId)
  const { wabaId } = await connectRegisteredWhatsApp(admin)
  await seedWorkflowTemplate(admin.companyId, wabaId, whatsappWorkflowKeys.metaAssign)
  await seedWorkflowTemplate(admin.companyId, wabaId, whatsappWorkflowKeys.transfer, {
    name: 'transfer_notice',
  })
  const { LeadTransfer } = getModels()
  const knownTransferIds = new Set()

  async function captureNewTransfer(leadId) {
    const where = {
      companyId: admin.companyId,
      leadId,
    }
    if (knownTransferIds.size > 0) {
      where.id = { [Op.notIn]: [...knownTransferIds] }
    }
    const row = await LeadTransfer.findOne({ where })
    assert.ok(row, 'expected a new LeadTransfer row after successful assignLead')
    knownTransferIds.add(row.id)
    return row
  }

  const created = await createLead(admin.auth, {
    name: 'Transfer Lead',
    phone: '+971505555801',
    source: leadSources.manual,
    statusId,
    primaryAgentId: agentA.id,
  })
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign), 1)
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.transfer), 0)

  // A → B
  await assignLead(admin.auth, created.lead.id, {
    primaryAgentId: agentB.id,
    reason: 'Move to B',
  })
  const transferAb = await captureNewTransfer(created.lead.id)
  assert.equal(String(transferAb.previousPrimaryAgentId), String(agentA.id))
  assert.equal(String(transferAb.primaryAgentId), String(agentB.id))
  let transferRows = await listOutbox(admin.companyId, whatsappWorkflowKeys.transfer)
  assert.equal(transferRows.length, 1)
  assert.equal(transferRows[0].recipientPhone, '+971509880002')
  assert.equal(
    transferRows[0].idempotencyKey,
    buildTransferIdempotencyKey({
      companyId: admin.companyId,
      leadId: created.lead.id,
      transferId: transferAb.id,
      primaryAgentId: agentB.id,
    }),
  )

  // Retry of the same A→B LeadTransfer event is idempotent
  const dup = await deliverLeadPrimaryWhatsApp({
    companyId: admin.companyId,
    leadId: created.lead.id,
    previousPrimaryAgentId: agentA.id,
    newPrimaryAgentId: agentB.id,
    transferId: transferAb.id,
    actorUserId: admin.userId,
    contactName: 'Transfer Lead',
    contactNumber: '+971505555801',
    workflowKey: whatsappWorkflowKeys.transfer,
    emailKind: assignmentNotifications.EMAIL_KINDS.transfer,
    idempotencyKey: buildTransferIdempotencyKey({
      companyId: admin.companyId,
      leadId: created.lead.id,
      transferId: transferAb.id,
      primaryAgentId: agentB.id,
    }),
  })
  assert.equal(dup.reason, 'idempotent')
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.transfer), 1)

  // Same-agent rejected — no extra WhatsApp / no new LeadTransfer
  await assert.rejects(
    () => assignLead(admin.auth, created.lead.id, { primaryAgentId: agentB.id }),
    (error) => error.statusCode === 400,
  )
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.transfer), 1)

  // null → A via Transfer dialog enqueues W1 (meta_assign), not W2
  const unassigned = await createLead(admin.auth, {
    name: 'Unassigned Transfer',
    phone: '+971505555802',
    source: leadSources.manual,
    statusId,
  })
  const metaBeforeFirstAssign = await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign)
  await assignLead(admin.auth, unassigned.lead.id, {
    primaryAgentId: agentA.id,
    reason: 'First assign',
  })
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.transfer), 1)
  assert.equal(
    await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign),
    metaBeforeFirstAssign + 1,
  )

  // B → C
  await assignLead(admin.auth, created.lead.id, {
    primaryAgentId: agentC.id,
    reason: 'Move to C',
  })
  const transferBc = await captureNewTransfer(created.lead.id)
  assert.notEqual(transferBc.id, transferAb.id)
  transferRows = await listOutbox(admin.companyId, whatsappWorkflowKeys.transfer)
  assert.equal(transferRows.length, 2)
  assert.ok(transferRows.some((row) => row.recipientPhone === '+971509880003'))
  assert.ok(transferRows.some((row) => row.idempotencyKey.includes(transferBc.id)))

  // C → A
  await assignLead(admin.auth, created.lead.id, {
    primaryAgentId: agentA.id,
    reason: 'Move to A',
  })
  const transferCa = await captureNewTransfer(created.lead.id)
  assert.notEqual(transferCa.id, transferBc.id)
  transferRows = await listOutbox(admin.companyId, whatsappWorkflowKeys.transfer)
  assert.equal(transferRows.length, 3)
  assert.ok(transferRows.some((row) => (
    row.recipientPhone === '+971509880001'
    && row.idempotencyKey.includes(transferCa.id)
  )))

  // Later legitimate A → B again creates a new notification (new LeadTransfer id)
  await assignLead(admin.auth, created.lead.id, {
    primaryAgentId: agentB.id,
    reason: 'Move to B again',
  })
  const transferAbAgain = await captureNewTransfer(created.lead.id)
  assert.notEqual(transferAbAgain.id, transferAb.id)
  transferRows = await listOutbox(admin.companyId, whatsappWorkflowKeys.transfer)
  assert.equal(transferRows.length, 4)
  assert.equal(
    transferRows.filter((row) => row.recipientPhone === '+971509880002').length,
    2,
  )
  assert.ok(transferRows.some((row) => row.idempotencyKey.includes(transferAbAgain.id)))
  assert.ok(transferRows.some((row) => row.idempotencyKey.includes(transferAb.id)))

  // Failed transfer (invalid agent) does not enqueue
  await assert.rejects(
    () => assignLead(admin.auth, created.lead.id, { primaryAgentId: uuidv4() }),
    (error) => error.statusCode === 400 || error.statusCode === 404,
  )
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.transfer), 4)

  // Four distinct successful A→B / B→C / C→A / A→B transitions → four keys
  const keys = new Set(transferRows.map((row) => row.idempotencyKey))
  assert.equal(keys.size, 4)
})

test('WhatsApp enqueue failure is fail-soft for create and transfer; company isolation held', async () => {
  const admin = await registerVerifiedAdmin('WaFailSoft')
  const other = await registerVerifiedAdmin('WaFailOther')
  const agentA = await createActiveAgent(admin.companyId, 'FS Agent A', '+971509770001')
  const agentB = await createActiveAgent(admin.companyId, 'FS Agent B', '+971509770002')
  const statusId = await defaultStatusId(admin.companyId)
  // No WhatsApp connection — enqueue path should skip, lead still succeeds
  const created = await createLead(admin.auth, {
    name: 'Fail Soft Lead',
    phone: '+971505555901',
    source: leadSources.manual,
    statusId,
    primaryAgentId: agentA.id,
  })
  assert.ok(created.lead.id)
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.metaAssign), 0)

  const transferred = await assignLead(admin.auth, created.lead.id, {
    primaryAgentId: agentB.id,
    reason: 'Still ok without WA',
  })
  assert.equal(String(transferred.lead.primaryAgent.id), String(agentB.id))
  assert.equal(await countOutbox(admin.companyId, whatsappWorkflowKeys.transfer), 0)
  assert.equal(await countOutbox(other.companyId, whatsappWorkflowKeys.metaAssign), 0)
  assert.equal(await countOutbox(other.companyId, whatsappWorkflowKeys.transfer), 0)
})

test('config presenter exposes workflow readiness without secrets', async () => {
  const admin = await registerVerifiedAdmin('WaUiCfg')
  const { wabaId } = await connectRegisteredWhatsApp(admin, {
    metaAssignEnabled: true,
    transferEnabled: false,
  })
  await seedWorkflowTemplate(admin.companyId, wabaId, whatsappWorkflowKeys.metaAssign)

  const config = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(config.status, 200)
  assert.equal(config.body.data.config.metaAssignEnabled, true)
  assert.equal(config.body.data.config.transferEnabled, false)
  assert.equal(config.body.data.config.workflows.metaAssign.ready, true)
  assert.equal(config.body.data.config.workflows.transfer.enabled, false)
  assert.equal(JSON.stringify(config.body).includes('EAA-wa-assignment-token'), false)
  assert.equal(JSON.stringify(config.body).includes('wa-app-secret-222'), false)

  const patched = await request(app)
    .patch('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ transferEnabled: true })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.data.config.transferEnabled, true)
  assert.equal(patched.body.data.config.workflows.transfer.reason, 'binding_missing')
})

test('hello_world binding is not Ready and is rejected by PUT binding API', async () => {
  const admin = await registerVerifiedAdmin('WaHelloBlock')
  const { wabaId } = await connectRegisteredWhatsApp(admin, {
    metaAssignEnabled: true,
    transferEnabled: true,
  })
  const { WhatsAppTemplate, WhatsAppWorkflowBinding } = getModels()
  const hello = await WhatsAppTemplate.create({
    id: uuidv4(),
    companyId: admin.companyId,
    wabaId,
    name: 'hello_world',
    language: 'en_US',
    status: messages.whatsappApprovedTemplateStatus,
    components: [{ type: 'BODY', text: 'Welcome and congratulations!!' }],
    bodyVariableKeys: [],
    isEnabled: true,
  })
  const rejected = await request(app)
    .put(`/api/whatsapp/workflow-bindings/${whatsappWorkflowKeys.transfer}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ templateId: hello.id })
  assert.equal(rejected.status, 400)

  // Legacy/direct binding must not report Ready.
  await WhatsAppWorkflowBinding.create({
    id: uuidv4(),
    companyId: admin.companyId,
    workflowKey: whatsappWorkflowKeys.transfer,
    templateId: hello.id,
  })
  const config = await request(app)
    .get('/api/whatsapp/config')
    .set('Authorization', `Bearer ${admin.token}`)
  assert.equal(config.status, 200)
  assert.equal(config.body.data.config.workflows.transfer.ready, false)
  assert.equal(config.body.data.config.workflows.transfer.reason, 'sample_template_forbidden')
  assert.equal(config.body.data.config.workflows.transfer.templateName, 'hello_world')
})
