'use strict'

/**
 * DB-free unit tests for push reliability helpers (claim/retry/privacy/invalid token).
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

process.env.NODE_ENV = 'test'
process.env.NOTIFICATION_PUSH_ENABLED = '1'

const {
  stringDataPayload,
  isInvalidFcmError,
  nextRetryAt,
  readMaxAttempts,
  isExpoToken,
} = require('../src/services/notificationPushService')
const { notificationPushMaxAttempts } = require('../src/utils/enums')

test('Expo/FCM allowlisted payload never includes phone, email, or leadLabel', () => {
  const data = stringDataPayload({
    id: 'n1',
    category: 'lead_assigned',
    entityType: 'lead',
    entityId: 'lead-1',
    data: {
      leadId: 'lead-1',
      href: '/leads/lead-1',
      leadLabel: 'Secret Name',
      phone: '+971500000000',
      email: 'a@b.com',
      arbitrary: 'nope',
    },
  })
  assert.equal(data.notificationId, 'n1')
  assert.equal(data.leadId, 'lead-1')
  assert.equal(data.href, '/leads/lead-1')
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'phone'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'email'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'leadLabel'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'arbitrary'), false)
})

test('invalid FCM detection ignores generic invalid-argument', () => {
  assert.equal(
    isInvalidFcmError({ code: 'messaging/registration-token-not-registered' }),
    true,
  )
  assert.equal(
    isInvalidFcmError({ code: 'messaging/invalid-registration-token' }),
    true,
  )
  assert.equal(
    isInvalidFcmError({ code: 'messaging/invalid-argument' }),
    false,
  )
  assert.equal(isInvalidFcmError({ message: 'quota exceeded' }), false)
})

test('Expo InvalidCredentials must not deactivate device tokens', () => {
  const { isInvalidExpoDeviceError } = require('../src/services/notificationPushService')
  assert.equal(isInvalidExpoDeviceError('InvalidCredentials'), false)
  assert.equal(isInvalidExpoDeviceError('DeviceNotRegistered'), true)
})

test('retry backoff is bounded and max attempts default is finite', () => {
  const first = nextRetryAt(1).getTime() - Date.now()
  const later = nextRetryAt(8).getTime() - Date.now()
  assert.ok(first >= 14_000 && first <= 20_000)
  assert.ok(later <= 301_000)
  assert.equal(readMaxAttempts(), notificationPushMaxAttempts)
  assert.ok(readMaxAttempts() >= 1 && readMaxAttempts() <= 20)
  assert.equal(isExpoToken('ExponentPushToken[x]'), true)
})

test('token length constant matches model width expectation', () => {
  const { MAX_TOKEN_LENGTH } = require('../src/services/notificationPushService')
  assert.equal(MAX_TOKEN_LENGTH, 512)
})

test('provider timeout is always strictly below lease (defaults + unsafe env clamp)', () => {
  const {
    getTimeoutLeaseInvariant,
    PROVIDER_TIMEOUT_SAFETY_MARGIN_MS,
  } = require('../src/services/notificationPushService')
  const defaults = getTimeoutLeaseInvariant()
  assert.equal(defaults.ok, true)
  assert.ok(defaults.timeoutMs < defaults.leaseMs)

  process.env.NOTIFICATION_PUSH_LEASE_MS = '10000'
  process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS = '55000'
  try {
    const clamped = getTimeoutLeaseInvariant()
    assert.equal(clamped.leaseMs, 10_000)
    assert.equal(clamped.timeoutMs, 10_000 - PROVIDER_TIMEOUT_SAFETY_MARGIN_MS)
    assert.equal(clamped.ok, true)
  } finally {
    delete process.env.NOTIFICATION_PUSH_LEASE_MS
    delete process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS
  }
})
