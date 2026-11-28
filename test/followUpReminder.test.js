'use strict'


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
process.env.NOTIFICATION_PUSH_ENABLED = '0'
process.env.FOLLOW_UP_REMINDER_ENABLED = '0'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const {
  normalizeLeadMinutes,
  processDueFollowUpReminders,
  reminderDueAt,
  scheduledInstantKey,
} = require('../src/services/followUpReminderService')

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'FuRem') {
  clearMemoryOutbox()
  const email = `${prefix.toLowerCase()}.${Date.now()}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName: uniqueName(prefix),
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
    companyId: login.body.data.user.company.id,
    accessToken: login.body.data.accessToken,
    userId: login.body.data.user.id,
  }
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('normalizeLeadMinutes and reminderDueAt honor allowlist and default', () => {
  assert.equal(normalizeLeadMinutes(15), 15)
  assert.equal(normalizeLeadMinutes(7), 5)
  assert.equal(normalizeLeadMinutes(undefined), 5)
  const followUp = new Date('2026-11-26T12:00:00.000Z')
  const due = reminderDueAt(followUp, 5)
  assert.equal(due.toISOString(), '2026-11-26T11:55:00.000Z')
  assert.ok(scheduledInstantKey(followUp).includes('2026-11-26T12:00'))
})

test('company followUpReminderMinutes get/patch allowlist', async () => {
  const admin = await registerVerifiedAdmin('FuCo')
  const get = await request(app)
    .get('/api/company')
    .set('Authorization', `Bearer ${admin.accessToken}`)
  assert.equal(get.status, 200)
  assert.equal(get.body.data.company.followUpReminderMinutes, 5)
  assert.deepEqual(
    get.body.data.company.followUpReminderMinutesOptions,
    [5, 10, 15, 25, 30, 60],
  )

  const bad = await request(app)
    .patch('/api/company')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      timezone: get.body.data.company.timezone,
      baseCurrency: get.body.data.company.baseCurrency,
      followUpReminderMinutes: 7,
    })
  assert.equal(bad.status, 400)

  const ok = await request(app)
    .patch('/api/company')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      timezone: get.body.data.company.timezone,
      baseCurrency: get.body.data.company.baseCurrency,
      followUpReminderMinutes: 15,
    })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.data.company.followUpReminderMinutes, 15)
})

test('follow-up reminder once per schedule; reschedule; clear skips; no overdue spam', async () => {
  const admin = await registerVerifiedAdmin('FuOnce')
  const { Lead, Company, Notification } = getModels()
  const company = await Company.findByPk(admin.companyId)
  company.followUpReminderMinutes = 5
  await company.save()

  const followUpAt = new Date(Date.now() + 5 * 60 * 1000)
  const statusId = (await request(app)
    .get('/api/catalog?kind=STATUS')
    .set('Authorization', `Bearer ${admin.accessToken}`)
  ).body.data.items.find((row) => row.key === 'new').id
  const lead = await Lead.create({
    id: uuidv4(),
    companyId: admin.companyId,
    number: 900001 + Math.floor(Math.random() * 1000),
    name: 'Follow Reminder Lead',
    phone: `+9198${String(Date.now()).slice(-8)}`,
    email: '',
    source: 'manual',
    currency: 'INR',
    statusId,
    primaryAgentId: admin.userId,
    nextFollowUpAt: followUpAt,
    entryMethod: 'manual',
  })

  const now = new Date()
  const first = await processDueFollowUpReminders({
    now,
    lookbackMs: 2 * 60 * 1000,
    aheadMs: 2 * 60 * 1000,
  })
  assert.ok(first.created >= 1)

  const second = await processDueFollowUpReminders({
    now,
    lookbackMs: 2 * 60 * 1000,
    aheadMs: 2 * 60 * 1000,
  })
  assert.equal(second.created, 0)

  const countAfterFirst = await Notification.count({
    where: { companyId: admin.companyId, userId: admin.userId, entityId: lead.id },
  })
  assert.equal(countAfterFirst, 1)

  // Reschedule → new idempotency key can create once.
  const rescheduled = new Date(Date.now() + 20 * 60 * 1000)
  lead.nextFollowUpAt = rescheduled
  await lead.save()
  const dueNow = new Date(rescheduled.getTime() - 5 * 60 * 1000)
  const afterReschedule = await processDueFollowUpReminders({
    now: dueNow,
    lookbackMs: 2 * 60 * 1000,
    aheadMs: 2 * 60 * 1000,
  })
  assert.equal(afterReschedule.created, 1)

  // Clear schedule → no pending reminder.
  lead.nextFollowUpAt = null
  await lead.save()
  const afterClear = await processDueFollowUpReminders({
    now: dueNow,
    lookbackMs: 60 * 60 * 1000,
    aheadMs: 60 * 60 * 1000,
  })
  assert.equal(afterClear.created, 0)

  // Overdue: past follow-up should not create another nag.
  lead.nextFollowUpAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  await lead.save()
  const overdue = await processDueFollowUpReminders({
    now: new Date(),
    lookbackMs: 24 * 60 * 60 * 1000,
    aheadMs: 2 * 60 * 1000,
  })
  assert.equal(overdue.created, 0)
})
