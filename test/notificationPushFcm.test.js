'use strict'

/**
 * Phase J2 — FCM Admin helpers (no live Firebase / no MySQL).
 */

const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')

process.env.NODE_ENV = 'test'
process.env.NOTIFICATION_PUSH_ENABLED = '1'

const {
  isExpoToken,
  resolveProvider,
  stringDataPayload,
  isInvalidFcmError,
} = require('../src/services/notificationPushService')
const { resetFirebaseAdminForTests } = require('../src/config/firebaseAdmin')
const { notificationProviders, devicePlatforms } = require('../src/utils/enums')

afterEach(() => {
  resetFirebaseAdminForTests()
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH
})

test('token provider detection', () => {
  assert.equal(isExpoToken('ExponentPushToken[abc]'), true)
  assert.equal(isExpoToken('ExpoPushToken[abc]'), true)
  assert.equal(isExpoToken('dGVzdC1mY20tdG9rZW4tbG9uZy1lbm91Z2g'), false)
  assert.equal(
    resolveProvider({ expoPushToken: 'ExponentPushToken[x]' }),
    notificationProviders.expo,
  )
  assert.equal(
    resolveProvider({ expoPushToken: 'native-fcm-token-value-long' }),
    notificationProviders.fcm,
  )
})

test('stringDataPayload never embeds secrets and builds href', () => {
  const data = stringDataPayload({
    id: 'n1',
    category: 'lead_assigned',
    entityType: 'lead',
    entityId: 'lead-1',
    data: { leadId: 'lead-1', href: '/leads/lead-1', phone: 'should-not-matter' },
  })
  assert.equal(data.notificationId, 'n1')
  assert.equal(data.leadId, 'lead-1')
  assert.equal(data.href, '/leads/lead-1')
  assert.equal(Object.keys(data).includes('phone'), false)
})

test('invalid FCM error detection', () => {
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

test('Expo InvalidCredentials is not treated as dead device token', () => {
  const { isInvalidExpoDeviceError } = require('../src/services/notificationPushService')
  assert.equal(isInvalidExpoDeviceError('InvalidCredentials'), false)
  assert.equal(isInvalidExpoDeviceError('DeviceNotRegistered'), true)
})

test('devicePlatforms includes web', () => {
  assert.equal(devicePlatforms.web, 'web')
  assert.equal(devicePlatforms.android, 'android')
  assert.equal(devicePlatforms.ios, 'ios')
})

test('firebase admin stays unconfigured without credentials', () => {
  const { isFirebaseAdminConfigured } = require('../src/config/firebaseAdmin')
  resetFirebaseAdminForTests()
  assert.equal(isFirebaseAdminConfigured(), false)
})
