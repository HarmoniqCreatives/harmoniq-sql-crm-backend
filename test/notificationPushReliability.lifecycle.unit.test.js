'use strict'

/**
 * DB-free lifecycle tests for notification push reliability.
 *
 * IMPORTANT: These tests use controlled dependency mocks (modelsApi.getModels,
 * global.fetch, firebase messaging). They do NOT prove real MySQL concurrency,
 * SKIP LOCKED exclusion, or live Sequelize commit/rollback semantics.
 *
 * Preload: HC_UNIT_TEST_BLOCK_DB + test/helpers/blockDbConnections.js
 */

const assert = require('node:assert/strict')
const { mock, test, beforeEach, afterEach, describe } = require('node:test')

process.env.NODE_ENV = 'test'
process.env.NOTIFICATION_PUSH_ENABLED = '1'
process.env.HC_UNIT_TEST_BLOCK_DB = '1'

const modelsApi = require('../src/models')
const notificationHub = require('../src/services/notificationHub')
const push = require('../src/services/notificationPushService')
const { notificationDeliveryStatuses, notificationCategories } = require('../src/utils/enums')

const originalGetModels = modelsApi.getModels.bind(modelsApi)
const originalPublishToUser = notificationHub.publishToUser.bind(notificationHub)

beforeEach(() => {
  mock.restoreAll()
  delete process.env.NOTIFICATION_PUSH_LEASE_MS
  delete process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS
  notificationHub.publishToUser = originalPublishToUser
})

afterEach(() => {
  mock.restoreAll()
  modelsApi.getModels = originalGetModels
  notificationHub.publishToUser = originalPublishToUser
  delete global.fetch
  delete process.env.NOTIFICATION_PUSH_LEASE_MS
  delete process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS
})

function uniqueError() {
  const err = new Error('Duplicate entry')
  err.name = 'SequelizeUniqueConstraintError'
  err.parent = { code: 'ER_DUP_ENTRY' }
  return err
}

describe('helpers (mocked / pure)', () => {
  test('InvalidCredentials is not an invalid Expo device token', () => {
    assert.equal(push.isInvalidExpoDeviceError('InvalidCredentials'), false)
    assert.equal(push.isInvalidExpoDeviceError('DeviceNotRegistered'), true)
    assert.equal(push.isInvalidExpoDeviceError('not a registered push token'), true)
  })

  test('isInvalidFcmError ignores invalid-argument and temporary failures', () => {
    assert.equal(push.isInvalidFcmError({ code: 'messaging/invalid-argument' }), false)
    assert.equal(push.isInvalidFcmError({ message: 'quota exceeded' }), false)
    assert.equal(
      push.isInvalidFcmError({ code: 'messaging/registration-token-not-registered' }),
      true,
    )
  })

  test('isSkipLockedUnsupportedError does not treat arbitrary errors as unsupported', () => {
    assert.equal(push.isSkipLockedUnsupportedError(new Error('connection lost')), false)
    assert.equal(push.isSkipLockedUnsupportedError(new Error('SKIP LOCKED not supported')), true)
    assert.equal(push.isSkipLockedUnsupportedError({ parent: { code: 'ER_PARSE_ERROR' } }), true)
  })

  test('stringDataPayload never includes phone/email/leadLabel', () => {
    const data = push.stringDataPayload({
      id: 'n1',
      category: 'lead_assigned',
      entityType: 'lead',
      entityId: 'lead-1',
      data: { phone: '+1', email: 'a@b.c', leadLabel: 'Secret', leadId: 'lead-1' },
    })
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'phone'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'email'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'leadLabel'), false)
  })

  test('deviceExistedAtNotificationTime excludes late-registered devices', () => {
    const notification = { createdAt: new Date('2026-11-28T10:00:00.000Z') }
    assert.equal(
      push.deviceExistedAtNotificationTime(
        { createdAt: new Date('2026-11-28T09:00:00.000Z') },
        notification,
      ),
      true,
    )
    assert.equal(
      push.deviceExistedAtNotificationTime(
        { createdAt: new Date('2026-11-28T11:00:00.000Z') },
        notification,
      ),
      false,
    )
  })

  test('MAX_TOKEN_LENGTH matches 512 schema width', () => {
    assert.equal(push.MAX_TOKEN_LENGTH, 512)
  })

  test('delivery status enum includes processing for leases', () => {
    assert.equal(notificationDeliveryStatuses.processing, 'processing')
    assert.equal(notificationDeliveryStatuses.queued, 'queued')
    assert.equal(notificationDeliveryStatuses.invalidToken, 'invalid_token')
  })
})

describe('timeout/lease invariant (mocked env — not live MySQL)', () => {
  test('defaults: lease exceeds provider timeout with safety margin', () => {
    const inv = push.getTimeoutLeaseInvariant()
    assert.equal(inv.leaseMs, push.DEFAULT_LEASE_MS)
    assert.equal(inv.timeoutMs, push.DEFAULT_PROVIDER_TIMEOUT_MS)
    assert.equal(inv.ok, true)
    assert.ok(inv.timeoutMs < inv.leaseMs - push.PROVIDER_TIMEOUT_SAFETY_MARGIN_MS + 1)
  })

  test('minimum lease (10s) clamps max timeout below lease', () => {
    process.env.NOTIFICATION_PUSH_LEASE_MS = '10000'
    process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS = '55000'
    const inv = push.getTimeoutLeaseInvariant()
    assert.equal(inv.leaseMs, 10_000)
    assert.ok(inv.timeoutMs < inv.leaseMs)
    assert.equal(inv.timeoutMs, 10_000 - push.PROVIDER_TIMEOUT_SAFETY_MARGIN_MS)
    assert.equal(inv.ok, true)
  })

  test('maximum requested provider timeout remains strictly below default lease', () => {
    process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS = '55000'
    const inv = push.getTimeoutLeaseInvariant()
    assert.equal(inv.leaseMs, push.DEFAULT_LEASE_MS)
    // 55s is within the allowed raw range and still < default lease − margin.
    assert.equal(inv.timeoutMs, 55_000)
    assert.ok(inv.timeoutMs < inv.leaseMs)
    assert.ok(inv.timeoutMs <= inv.leaseMs - push.PROVIDER_TIMEOUT_SAFETY_MARGIN_MS)
    assert.equal(inv.ok, true)
  })

  test('invalid env timeout falls back then still respects lease', () => {
    process.env.NOTIFICATION_PUSH_LEASE_MS = '12000'
    process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS = '999'
    const inv = push.getTimeoutLeaseInvariant()
    assert.equal(inv.ok, true)
    assert.ok(inv.timeoutMs < inv.leaseMs)
  })
})

describe('provider paths (mocked fetch / messaging — not live providers)', () => {
  test('Expo InvalidCredentials returns invalid:false (retry, do not deactivate)', async () => {
    global.fetch = mock.fn(async () => ({
      status: 200,
      json: async () => ({ data: { status: 'error', message: 'InvalidCredentials' } }),
    }))
    const result = await push.sendExpoPush(
      { expoPushToken: 'ExponentPushToken[abc]', platform: 'android' },
      { id: 'n1', title: 't', body: 'b', category: 'lead_assigned', entityType: 'lead', entityId: 'l1', data: {} },
    )
    assert.equal(result.ok, false)
    assert.equal(result.invalid, false)
    assert.match(result.errorCode, /InvalidCredentials/)
  })

  test('Expo request timeout returns retryable failure', async () => {
    global.fetch = mock.fn(async (_url, options) => {
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS = '1000'
    try {
      const result = await push.sendExpoPush(
        { expoPushToken: 'ExponentPushToken[abc]', platform: 'android' },
        { id: 'n1', title: 't', body: 'b', category: 'c', entityType: 'lead', entityId: 'l1', data: {} },
      )
      assert.equal(result.ok, false)
      assert.equal(result.invalid, false)
      assert.match(result.errorCode, /timeout|aborted|provider_timeout/i)
    } finally {
      delete process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS
    }
  })

  test('fetchWithTimeout aborts and throws provider_timeout', async () => {
    global.fetch = mock.fn(async (_url, options) => {
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    await assert.rejects(
      () => push.fetchWithTimeout('https://example.test', { method: 'GET' }, 15),
      /provider_timeout/,
    )
  })

  test('sendFcmAdmin Promise.race timeout does not mark token invalid (mocked messaging)', async () => {
    process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS = '1000'
    const firebaseAdmin = require('../src/config/firebaseAdmin')
    const original = firebaseAdmin.getFirebaseMessaging
    firebaseAdmin.getFirebaseMessaging = () => ({
      send: async () => new Promise(() => { /* never resolves — simulates hung SDK */ }),
    })
    try {
      const result = await push.sendFcmAdmin(
        { expoPushToken: 'fcm-token-value-long-enough', platform: 'android' },
        { id: 'n1', title: 't', body: 'b', category: 'lead_assigned', entityType: 'lead', entityId: 'l1', data: {} },
      )
      assert.equal(result.ok, false)
      assert.equal(result.invalid, false)
      assert.match(result.errorCode, /provider_timeout|PROVIDER_TIMEOUT/i)
    } finally {
      firebaseAdmin.getFirebaseMessaging = original
      delete process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS
    }
  })
})

describe('queue / finalize (mocked models — not live MySQL)', () => {
  test('queueDeliveriesForNotification skips cross-tenant and late devices', async () => {
    const notificationAt = new Date('2026-11-28T12:00:00.000Z')
    const created = []
    const devices = [
      {
        id: 'd1',
        companyId: 'co-1',
        userId: 'u-1',
        isActive: true,
        expoPushToken: 'native-fcm-token-value-long-enough',
        platform: 'android',
        createdAt: new Date('2026-11-28T11:00:00.000Z'),
      },
      {
        id: 'd-other-co',
        companyId: 'co-OTHER',
        userId: 'u-1',
        isActive: true,
        expoPushToken: 'other-company-token-value-long',
        platform: 'android',
        createdAt: new Date('2026-11-28T11:00:00.000Z'),
      },
      {
        id: 'd-late',
        companyId: 'co-1',
        userId: 'u-1',
        isActive: true,
        expoPushToken: 'late-device-token-value-long-enough',
        platform: 'android',
        createdAt: new Date('2026-11-28T13:00:00.000Z'),
      },
    ]

    modelsApi.getModels = () => ({
      UserDeviceToken: {
        findAll: async () => devices.filter((d) => (
          d.companyId === 'co-1'
          && d.userId === 'u-1'
          && d.isActive
          && d.createdAt <= notificationAt
        )),
      },
      NotificationDelivery: {
        create: async (row) => {
          created.push(row)
          return row
        },
      },
    })

    const result = await push.queueDeliveriesForNotification({
      id: 'n1',
      companyId: 'co-1',
      userId: 'u-1',
      createdAt: notificationAt,
    })
    assert.equal(result.queued, 1)
    assert.equal(created.length, 1)
    assert.equal(created[0].deviceTokenId, 'd1')
    assert.equal(created[0].notificationId, 'n1')
  })

  test('queueDeliveriesForNotification is duplicate-safe via unique constraint', async () => {
    let calls = 0
    modelsApi.getModels = () => ({
      UserDeviceToken: {
        findAll: async () => ([{
          id: 'd1',
          companyId: 'co-1',
          userId: 'u-1',
          isActive: true,
          expoPushToken: 'ExponentPushToken[x]',
          platform: 'android',
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
        }]),
      },
      NotificationDelivery: {
        create: async () => {
          calls += 1
          throw uniqueError()
        },
      },
    })
    const result = await push.queueDeliveriesForNotification({
      id: 'n1',
      companyId: 'co-1',
      userId: 'u-1',
      createdAt: new Date('2026-11-28T00:00:00.000Z'),
    })
    assert.equal(calls, 1)
    assert.equal(result.queued, 0)
    assert.ok(result.skipped >= 1)
  })

  test('finalizeDeliveryFailure with invalid:false does not deactivate device token', async () => {
    const updates = []
    const deviceUpdates = []
    modelsApi.getModels = () => ({
      NotificationDelivery: {
        update: async (values, opts) => {
          updates.push({ values, opts })
          return [1]
        },
      },
      UserDeviceToken: {
        update: async (values, opts) => {
          deviceUpdates.push({ values, opts })
          return [1]
        },
      },
    })

    const outcome = await push.finalizeDeliveryFailure(
      {
        id: 'del-1',
        lockToken: 'lock-1',
        attempt: 0,
        deviceTokenId: 'd1',
      },
      { ok: false, errorCode: 'InvalidCredentials', invalid: false },
    )
    assert.equal(outcome.permanent, false)
    assert.equal(outcome.finalized, true)
    assert.equal(updates[0].values.status, notificationDeliveryStatuses.queued)
    assert.equal(deviceUpdates.length, 0)
  })

  test('finalizeDeliveryFailure with invalid:true deactivates only that deviceTokenId', async () => {
    const deviceUpdates = []
    modelsApi.getModels = () => ({
      NotificationDelivery: {
        update: async () => [1],
      },
      UserDeviceToken: {
        update: async (values, opts) => {
          deviceUpdates.push({ values, opts })
          return [1]
        },
      },
    })
    const outcome = await push.finalizeDeliveryFailure(
      {
        id: 'del-1',
        lockToken: 'lock-1',
        attempt: 0,
        deviceTokenId: 'd1',
      },
      { ok: false, errorCode: 'DeviceNotRegistered', invalid: true },
    )
    assert.equal(outcome.permanent, true)
    assert.equal(deviceUpdates.length, 1)
    assert.deepEqual(deviceUpdates[0].opts.where, { id: 'd1' })
    assert.equal(deviceUpdates[0].values.isActive, false)
  })

  test('reconcileMissingPushDeliveries inserts only missing pairs (partial queue)', async () => {
    const created = []
    const missingPairs = [
      {
        notificationId: 'n1',
        companyId: 'co-1',
        userId: 'u-1',
        notificationCreatedAt: new Date('2026-11-28T10:00:00.000Z'),
        deviceTokenId: 'd2',
        expoPushToken: 'token-d2-long-enough-value',
        platform: 'android',
        deviceCreatedAt: new Date('2026-11-28T09:00:00.000Z'),
      },
      {
        notificationId: 'n1',
        companyId: 'co-1',
        userId: 'u-1',
        notificationCreatedAt: new Date('2026-11-28T10:00:00.000Z'),
        deviceTokenId: 'd3',
        expoPushToken: 'token-d3-long-enough-value',
        platform: 'android',
        deviceCreatedAt: new Date('2026-11-28T09:30:00.000Z'),
      },
    ]
    modelsApi.getModels = () => ({
      sequelize: {
        query: async () => missingPairs,
      },
      NotificationDelivery: {
        create: async (row) => {
          created.push(row)
          return row
        },
      },
    })

    const result = await push.reconcileMissingPushDeliveries({ lookbackHours: 24, limit: 50 })
    assert.equal(result.scanned, 2)
    assert.equal(result.queued, 2)
    assert.equal(created.length, 2)
    assert.deepEqual(created.map((r) => r.deviceTokenId).sort(), ['d2', 'd3'])
  })

  test('reconcileMissingPushDeliveries skips duplicate unique conflicts', async () => {
    modelsApi.getModels = () => ({
      sequelize: {
        query: async () => ([{
          notificationId: 'n1',
          companyId: 'co-1',
          userId: 'u-1',
          notificationCreatedAt: new Date('2026-11-28T10:00:00.000Z'),
          deviceTokenId: 'd2',
          expoPushToken: 'token-d2-long-enough-value',
          platform: 'android',
          deviceCreatedAt: new Date('2026-11-28T09:00:00.000Z'),
        }]),
      },
      NotificationDelivery: {
        create: async () => {
          throw uniqueError()
        },
      },
    })
    const result = await push.reconcileMissingPushDeliveries({ limit: 10 })
    assert.equal(result.queued, 0)
    assert.equal(result.skipped, 1)
  })

  test('reconcile continues after one device insert failure', async () => {
    let attempts = 0
    modelsApi.getModels = () => ({
      sequelize: {
        query: async () => ([
          {
            notificationId: 'n1',
            companyId: 'co-1',
            userId: 'u-1',
            notificationCreatedAt: new Date('2026-11-28T10:00:00.000Z'),
            deviceTokenId: 'd-bad',
            expoPushToken: 'token-bad-long-enough-value',
            platform: 'android',
            deviceCreatedAt: new Date('2026-11-28T09:00:00.000Z'),
          },
          {
            notificationId: 'n1',
            companyId: 'co-1',
            userId: 'u-1',
            notificationCreatedAt: new Date('2026-11-28T10:00:00.000Z'),
            deviceTokenId: 'd-ok',
            expoPushToken: 'token-ok-long-enough-value',
            platform: 'android',
            deviceCreatedAt: new Date('2026-11-28T09:00:00.000Z'),
          },
        ]),
      },
      NotificationDelivery: {
        create: async (row) => {
          attempts += 1
          if (row.deviceTokenId === 'd-bad') {
            throw new Error('simulated insert failure')
          }
          return row
        },
      },
    })
    const result = await push.reconcileMissingPushDeliveries({ limit: 10 })
    assert.equal(attempts, 2)
    assert.equal(result.queued, 1)
    assert.equal(result.skipped, 1)
  })
})

describe('createNotification transactional durability (mocked models/txn — not live Sequelize/MySQL)', () => {
  function installCreateNotificationMocks(opts = {}) {
    const {
      existing = null,
      createThrows = null,
      deliveries = [],
      persistedAfterCommit = true,
      queueError = null,
    } = opts
    const afterCommitCallbacks = []
    const notificationRow = {
      id: 'n-created-1',
      companyId: 'co-1',
      userId: 'u-1',
      category: notificationCategories.leadAssigned,
      title: 'Lead assigned',
      body: 'You were assigned a lead.',
      createdAt: new Date('2026-11-28T10:00:00.000Z'),
      data: { leadId: 'lead-1', href: '/leads/lead-1' },
      entityType: 'lead',
      entityId: 'lead-1',
    }

    modelsApi.getModels = () => ({
      User: {
        findOne: async () => ({ id: 'u-1', companyId: 'co-1', status: 'active' }),
      },
      Notification: {
        findOne: async ({ where }) => {
          if (where.idempotencyKey) return existing
          // createNotification assigns a fresh UUID; verifyPersisted looks up by that id.
          if (where.id) {
            if (!persistedAfterCommit) return null
            return {
              ...notificationRow,
              id: where.id,
              companyId: where.companyId || notificationRow.companyId,
              userId: where.userId || notificationRow.userId,
            }
          }
          return null
        },
        create: async (row, createOpts) => {
          if (createThrows) throw createThrows
          assert.ok(createOpts && createOpts.transaction, 'create must receive transaction when provided')
          return { ...notificationRow, ...row }
        },
        count: async () => 0,
      },
      UserDeviceToken: {
        findAll: async (findOpts = {}) => {
          if (opts.expectTxnOnQueue) {
            assert.ok(findOpts.transaction, 'queue findAll must use same transaction')
          }
          return [{
            id: 'd1',
            companyId: 'co-1',
            userId: 'u-1',
            isActive: true,
            expoPushToken: 'fcm-token-value-long-enough-xx',
            platform: 'android',
            createdAt: new Date('2026-11-28T09:00:00.000Z'),
          }]
        },
      },
      NotificationDelivery: {
        create: async (row, createOpts = {}) => {
          if (queueError) throw queueError
          if (opts.expectTxnOnQueue) {
            assert.ok(createOpts.transaction, 'delivery create must use same transaction')
          }
          deliveries.push(row)
          return row
        },
      },
    })

    const transaction = {
      afterCommit(fn) {
        afterCommitCallbacks.push(fn)
      },
    }
    return { transaction, afterCommitCallbacks, deliveries, notificationRow }
  }

  test('successful commit path: queues deliveries in txn and SSE afterCommit verifies persist', async () => {
    const { createNotification } = require('../src/services/notificationService')
    const deliveries = []
    const sseEvents = []
    notificationHub.publishToUser = (companyId, userId, event) => {
      sseEvents.push({ companyId, userId, event })
      return 1
    }
    const { transaction, afterCommitCallbacks } = installCreateNotificationMocks({
      deliveries,
      expectTxnOnQueue: true,
      persistedAfterCommit: true,
    })

    const result = await createNotification({
      companyId: 'co-1',
      userId: 'u-1',
      category: notificationCategories.leadAssigned,
      title: 'Lead assigned',
      body: 'You were assigned a lead.',
      idempotencyKey: 'lead_assigned:co-1:lead-1:u-1',
      entityType: 'lead',
      entityId: 'lead-1',
      data: { leadId: 'lead-1', href: '/leads/lead-1' },
      transaction,
    })

    assert.equal(result.created, true)
    assert.equal(deliveries.length, 1)
    assert.equal(afterCommitCallbacks.length, 1)
    assert.equal(sseEvents.length, 0, 'SSE must wait for afterCommit')
    // Simulate successful commit invoking afterCommit (mocked — not real Sequelize).
    await afterCommitCallbacks[0]()
    assert.equal(sseEvents.length, 1)
    assert.equal(sseEvents[0].event.type, 'notification.created')
    assert.equal(sseEvents[0].companyId, 'co-1')
    assert.equal(sseEvents[0].userId, 'u-1')
  })

  test('explicit rollback: afterCommit never runs → no SSE; queued rows stay non-durable', async () => {
    const { createNotification } = require('../src/services/notificationService')
    const deliveries = []
    const sseEvents = []
    notificationHub.publishToUser = (companyId, userId, event) => {
      sseEvents.push({ companyId, userId, event })
      return 1
    }
    const { transaction, afterCommitCallbacks } = installCreateNotificationMocks({
      deliveries,
      expectTxnOnQueue: true,
    })

    const result = await createNotification({
      companyId: 'co-1',
      userId: 'u-1',
      category: notificationCategories.leadAssigned,
      title: 'Lead assigned',
      body: 'You were assigned a lead.',
      idempotencyKey: 'ik-rollback-1',
      transaction,
    })
    assert.equal(result.created, true)
    // In-txn queue may stage delivery objects in memory; they are not durable until commit.
    assert.equal(deliveries.length, 1)
    assert.equal(afterCommitCallbacks.length, 1)
    // Simulate Sequelize rollback(): afterCommit hooks are never invoked.
    assert.equal(sseEvents.length, 0, 'rollback must not emit notification SSE')
    // Worker must not treat uncommitted staged rows as claimable durable work.
    const claimSpy = mock.method(push, 'claimQueuedDeliveries', async () => [])
    const processed = await push.processQueuedDeliveries(10)
    assert.equal(processed.processed, 0)
    assert.equal(claimSpy.mock.callCount(), 1)
    assert.equal(sseEvents.length, 0)
  })

  test('failed COMMIT: afterCommit may fire but SSE is not emitted when row is not persisted', async () => {
    const { createNotification } = require('../src/services/notificationService')
    const sseEvents = []
    notificationHub.publishToUser = (companyId, userId, event) => {
      sseEvents.push({ companyId, userId, event })
      return 1
    }
    const { transaction, afterCommitCallbacks } = installCreateNotificationMocks({
      deliveries: [],
      expectTxnOnQueue: true,
      persistedAfterCommit: false,
    })

    await createNotification({
      companyId: 'co-1',
      userId: 'u-1',
      category: notificationCategories.leadAssigned,
      title: 'Lead assigned',
      body: 'You were assigned a lead.',
      idempotencyKey: 'ik-failed-commit',
      transaction,
    })
    assert.equal(afterCommitCallbacks.length, 1)
    assert.equal(sseEvents.length, 0)
    // Sequelize 6.37.8 may still run afterCommit in finally — verifyPersisted must suppress SSE.
    await afterCommitCallbacks[0]()
    assert.equal(sseEvents.length, 0, 'failed COMMIT must not emit SSE when notification is missing')
  })

  test('duplicate notification does not queue or register afterCommit', async () => {
    const { createNotification } = require('../src/services/notificationService')
    const deliveries = []
    const sseEvents = []
    notificationHub.publishToUser = (companyId, userId, event) => {
      sseEvents.push({ companyId, userId, event })
      return 1
    }
    const existing = {
      id: 'n-existing',
      companyId: 'co-1',
      userId: 'u-1',
      idempotencyKey: 'ik-dup',
    }
    const { transaction, afterCommitCallbacks } = installCreateNotificationMocks({
      existing,
      deliveries,
    })

    const result = await createNotification({
      companyId: 'co-1',
      userId: 'u-1',
      category: notificationCategories.leadAssigned,
      title: 'Lead assigned',
      body: 'You were assigned a lead.',
      idempotencyKey: 'ik-dup',
      transaction,
    })
    assert.equal(result.created, false)
    assert.equal(result.duplicate, true)
    assert.equal(deliveries.length, 0)
    assert.equal(afterCommitCallbacks.length, 0)
    assert.equal(sseEvents.length, 0)
  })

  test('fan-out queue failure in txn is fail-soft (notification still created)', async () => {
    const { createNotification } = require('../src/services/notificationService')
    const { transaction, afterCommitCallbacks } = installCreateNotificationMocks({
      expectTxnOnQueue: true,
      queueError: new Error('queue boom'),
    })

    const result = await createNotification({
      companyId: 'co-1',
      userId: 'u-1',
      category: notificationCategories.leadAssigned,
      title: 'Lead assigned',
      body: 'You were assigned a lead.',
      idempotencyKey: 'ik-queue-fail',
      transaction,
    })
    assert.equal(result.created, true)
    assert.equal(afterCommitCallbacks.length, 1)
  })
})

describe('lease ownership (mocked — not live MySQL concurrency)', () => {
  function baseDelivery() {
    return {
      id: 'del-1',
      deviceTokenId: 'd1',
      notificationId: 'n1',
      provider: 'expo',
      attempt: 0,
      lockToken: 'lock-owner-1',
    }
  }

  function installProcessModels() {
    modelsApi.getModels = () => ({
      UserDeviceToken: {
        findByPk: async () => ({
          id: 'd1',
          companyId: 'co-1',
          userId: 'u-1',
          isActive: true,
          expoPushToken: 'ExponentPushToken[abc]',
          platform: 'android',
        }),
      },
      Notification: {
        findByPk: async () => ({
          id: 'n1',
          companyId: 'co-1',
          userId: 'u-1',
          title: 't',
          body: 'b',
          category: 'lead_assigned',
          entityType: 'lead',
          entityId: 'l1',
          data: {},
        }),
      },
      NotificationDelivery: {
        update: async () => [1],
      },
    })
  }

  test('failed lease renewal prevents provider send', async () => {
    installProcessModels()
    let sendCalls = 0
    mock.method(push, 'claimQueuedDeliveries', async () => [baseDelivery()])
    mock.method(push, 'renewDeliveryLease', async () => ({ renewed: false }))
    mock.method(push, 'sendExpoPush', async () => {
      sendCalls += 1
      return { ok: true, providerMessageId: 'x' }
    })
    mock.method(push, 'finalizeDeliverySuccess', async () => ({ finalized: true }))
    mock.method(push, 'finalizeDeliveryFailure', async () => ({ permanent: false, finalized: true }))

    const result = await push.processQueuedDeliveries(5)
    assert.equal(sendCalls, 0)
    assert.equal(result.skippedLease, 1)
    assert.equal(result.sent, 0)
    assert.equal(result.failed, 0)
    assert.equal(result.requeued, 0)
  })

  test('successful lease renewal allows the normal send path', async () => {
    installProcessModels()
    let sendCalls = 0
    mock.method(push, 'claimQueuedDeliveries', async () => [baseDelivery()])
    mock.method(push, 'renewDeliveryLease', async () => ({ renewed: true }))
    mock.method(push, 'sendExpoPush', async () => {
      sendCalls += 1
      return { ok: true, providerMessageId: 'msg-1' }
    })
    mock.method(push, 'finalizeDeliverySuccess', async () => ({ finalized: true }))

    const result = await push.processQueuedDeliveries(5)
    assert.equal(sendCalls, 1)
    assert.equal(result.skippedLease, 0)
    assert.equal(result.sent, 1)
  })

  test('stale lock ownership prevents finalization', async () => {
    modelsApi.getModels = () => ({
      NotificationDelivery: {
        update: async () => [0],
      },
      UserDeviceToken: {
        update: async () => {
          throw new Error('must not deactivate on stale finalize')
        },
      },
    })
    const success = await push.finalizeDeliverySuccess(
      { id: 'del-1', lockToken: 'stale-lock', attempt: 1 },
      'provider-msg',
    )
    assert.equal(success.finalized, false)

    const failure = await push.finalizeDeliveryFailure(
      { id: 'del-1', lockToken: 'stale-lock', attempt: 0, deviceTokenId: 'd1' },
      { ok: false, errorCode: 'DeviceNotRegistered', invalid: true },
    )
    assert.equal(failure.finalized, false)
    assert.equal(failure.permanent, true)
  })
})
