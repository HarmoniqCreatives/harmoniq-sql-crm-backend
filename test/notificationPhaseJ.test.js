'use strict'

/**
 * Phase J — cross-platform notification engine unit tests (no MySQL required).
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

process.env.MAIL_DRIVER = process.env.MAIL_DRIVER || 'memory'
process.env.NODE_ENV = 'test'
process.env.WHATSAPP_OUTBOX_AUTORUN = '0'
process.env.FOLLOW_UP_REMINDER_ENABLED = '0'

const inAppNotifications = require('../src/services/notificationService')
const inbox = require('../src/services/notificationInboxService')
const hub = require('../src/services/notificationHub')
const followUp = require('../src/services/followUpReminderService')
const { notificationCategories } = require('../src/utils/enums')

test('notifyLeadActivity skip gates (no DB)', async () => {
  const invalid = await inAppNotifications.notifyLeadActivity({
    companyId: 'co-1',
    leadId: 'lead-1',
  })
  assert.equal(invalid.skipped, true)
  assert.equal(invalid.reason, 'invalid_input')

  const self = await inAppNotifications.notifyLeadActivity({
    companyId: 'co-1',
    leadId: 'lead-1',
    primaryAgentId: 'agent-1',
    actorUserId: 'agent-1',
    activityId: 'act-1',
  })
  assert.equal(self.skipped, true)
  assert.equal(self.reason, 'actor_is_recipient')
})

test('notifyLeadTransferred skips unchanged primary', async () => {
  const same = await inAppNotifications.notifyLeadTransferred({
    companyId: 'co-1',
    leadId: 'lead-1',
    previousPrimaryAgentId: 'agent-1',
    newPrimaryAgentId: 'agent-1',
    transferId: 'xfer-1',
  })
  assert.equal(same.skipped, true)
  assert.equal(same.reason, 'unchanged_primary')
})

test('presentNotification builds href from entity or data', () => {
  const withData = inbox.presentNotification({
    id: 'n1',
    category: notificationCategories.leadAssigned,
    title: 'T',
    body: 'B',
    data: { href: '/leads/abc', leadId: 'abc' },
    entityType: 'lead',
    entityId: 'abc',
    readAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(withData.href, '/leads/abc')
  assert.equal(withData.readAt, null)

  const fromEntity = inbox.presentNotification({
    id: 'n2',
    category: notificationCategories.leadTransferred,
    title: 'T',
    body: 'B',
    data: null,
    entityType: 'lead',
    entityId: 'lead-99',
    readAt: null,
    createdAt: new Date(),
  })
  assert.equal(fromEntity.href, '/leads/lead-99')
})

test('SSE hub isolates users and companies', () => {
  const writesA = []
  const writesB = []
  const resA = { write: (chunk) => writesA.push(chunk) }
  const resB = { write: (chunk) => writesB.push(chunk) }

  const unsubA = hub.subscribe('co-1', 'user-a', resA)
  const unsubB = hub.subscribe('co-1', 'user-b', resB)

  const sentA = hub.publishToUser('co-1', 'user-a', { type: 'notification.created', id: 1 })
  assert.equal(sentA, 1)
  assert.equal(writesA.length, 1)
  assert.equal(writesB.length, 0)
  assert.match(writesA[0], /notification\.created/)

  const sentWrongCompany = hub.publishToUser('co-2', 'user-a', { type: 'x' })
  assert.equal(sentWrongCompany, 0)
  assert.equal(writesA.length, 1)

  unsubA()
  unsubB()
  assert.equal(hub.publishToUser('co-1', 'user-a', { type: 'gone' }), 0)
})

test('follow-up idempotency minute key is stable per UTC minute', async () => {
  assert.equal(
    followUp.minuteKeyFromDate(new Date('2026-06-15T10:30:45.123Z')),
    '2026-06-15T10:30',
  )
  assert.equal(
    followUp.minuteKeyFromDate(new Date('2026-06-15T10:30:01.000Z')),
    '2026-06-15T10:30',
  )
  const skipped = await followUp.notifyFollowUpReminder({
    companyId: 'co',
    leadId: 'lead',
    primaryAgentId: '',
    followUpAt: new Date(),
  })
  assert.equal(skipped.skipped, true)
})

test('safeNotify swallows errors', async () => {
  const result = await inAppNotifications.safeNotify(async () => {
    throw new Error('boom')
  }, {})
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'notify_failed')
})

test('categories cover Phase J set', () => {
  assert.equal(notificationCategories.leadAssigned, 'lead_assigned')
  assert.equal(notificationCategories.leadTransferred, 'lead_transferred')
  assert.equal(notificationCategories.followUp, 'follow_up')
  assert.equal(notificationCategories.leadActivity, 'lead_activity')
  assert.equal(notificationCategories.systemAlert, 'system_alert')
})
