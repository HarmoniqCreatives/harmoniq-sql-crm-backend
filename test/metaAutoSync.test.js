const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { after, beforeEach, describe, test } = require('node:test')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.META_SYNC_AUTORUN = '0'
process.env.META_AUTO_SYNC_ENABLED = 'false'
process.env.META_AUTO_SYNC_INTERVAL_MINUTES = '10'
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token'
process.env.META_APP_SECRET = 'test-app-secret'
process.env.META_APP_ID = 'test-app-id'
process.env.META_REDIRECT_URI = 'http://localhost:5001/api/meta/oauth/callback'
process.env.APP_BASE_URL = 'http://localhost:5174'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex')

const {
  ALLOWED_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  readMetaAutoSyncConfig,
  assertMetaAutoSyncConfig,
} = require('../src/config/metaAutoSync')

describe('metaAutoSync config (env-only)', () => {
  test('defaults: disabled + 10 minute interval when unset', () => {
    const config = readMetaAutoSyncConfig({})
    assert.equal(config.enabled, false)
    assert.equal(config.intervalMinutes, DEFAULT_INTERVAL_MINUTES)
    assert.equal(config.intervalMs, DEFAULT_INTERVAL_MINUTES * 60 * 1000)
    assert.deepEqual(ALLOWED_INTERVAL_MINUTES, [10, 15])
  })

  test('META_AUTO_SYNC_ENABLED=true enables periodic schedule', () => {
    const config = readMetaAutoSyncConfig({
      META_AUTO_SYNC_ENABLED: 'true',
      META_AUTO_SYNC_INTERVAL_MINUTES: '10',
    })
    assert.equal(config.enabled, true)
    assert.equal(config.intervalMinutes, 10)
    assert.equal(config.intervalMs, 10 * 60 * 1000)
  })

  test('META_AUTO_SYNC_ENABLED=false disables only periodic Auto Sync', () => {
    const config = readMetaAutoSyncConfig({
      META_AUTO_SYNC_ENABLED: 'false',
      META_AUTO_SYNC_INTERVAL_MINUTES: '15',
    })
    assert.equal(config.enabled, false)
    assert.equal(config.intervalMinutes, 15)
    assert.equal(config.intervalMs, 15 * 60 * 1000)
  })

  test('accepts interval 10 minutes', () => {
    const config = readMetaAutoSyncConfig({
      META_AUTO_SYNC_ENABLED: '1',
      META_AUTO_SYNC_INTERVAL_MINUTES: '10',
    })
    assert.equal(config.enabled, true)
    assert.equal(config.intervalMinutes, 10)
  })

  test('accepts interval 15 minutes', () => {
    const config = readMetaAutoSyncConfig({
      META_AUTO_SYNC_ENABLED: 'true',
      META_AUTO_SYNC_INTERVAL_MINUTES: '15',
    })
    assert.equal(config.enabled, true)
    assert.equal(config.intervalMinutes, 15)
    assert.equal(config.intervalMs, 15 * 60 * 1000)
  })

  test('rejects invalid interval with a clear error', () => {
    assert.throws(
      () => readMetaAutoSyncConfig({ META_AUTO_SYNC_INTERVAL_MINUTES: '5' }),
      /META_AUTO_SYNC_INTERVAL_MINUTES must be one of 10 or 15/,
    )
    assert.throws(
      () => assertMetaAutoSyncConfig({ META_AUTO_SYNC_INTERVAL_MINUTES: '20' }),
      /META_AUTO_SYNC_INTERVAL_MINUTES must be one of 10 or 15/,
    )
  })

  test('rejects invalid enabled flag with a clear error', () => {
    assert.throws(
      () => readMetaAutoSyncConfig({ META_AUTO_SYNC_ENABLED: 'yes' }),
      /META_AUTO_SYNC_ENABLED must be true or false/,
    )
  })
})

describe('metaAutoSync scheduler isolation', () => {
  const autoSync = require('../src/services/metaAutoSyncService')
  const { app } = require('../src/server')
  const request = require('supertest')
  const { getModels } = require('../src/models')
  const { encryptSecret } = require('../src/utils/metaSecrets')
  const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')

  beforeEach(() => {
    autoSync.resetMetaAutoSyncSchedulerForTests()
  })

  after(() => {
    autoSync.resetMetaAutoSyncSchedulerForTests()
  })

  async function registerVerifiedAdmin(prefix = 'AutoSync') {
    clearMemoryOutbox()
    const companyName = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    const email = `autosync.${Date.now()}.${Math.floor(Math.random() * 1000)}@example.com`
    await request(app).post('/api/auth/register').send({
      companyName,
      adminName: 'Auto Sync Admin',
      email,
      phone: '+919876543210',
      password: 'Password1!',
      confirmPassword: 'Password1!',
    })
    const link = getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)
    await request(app).post('/api/auth/verify-email').send({
      token: decodeURIComponent(link[1]),
    })
    const login = await request(app).post('/api/auth/login').send({
      email,
      password: 'Password1!',
    })
    return {
      token: login.body.data.accessToken,
      companyId: login.body.data.user.company.id,
      userId: login.body.data.user.id,
    }
  }

  async function seedConnectedPage(admin, pageId) {
    const { MetaAppProfile, MetaConnection, MetaPage } = getModels()
    const profile = await MetaAppProfile.create({
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      mode: 'customer',
      label: `AutoSync ${pageId}`,
      appId: 'app-autosync',
      appSecretCipher: encryptSecret('secret'),
      secretStored: true,
      isActive: true,
      createdBy: admin.userId,
      updatedBy: admin.userId,
    })
    const connection = await MetaConnection.create({
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      appProfileId: profile.id,
      metaUserId: `mu-${pageId}`,
      displayName: 'AutoSync User',
      status: 'connected',
      grantedPermissions: ['leads_retrieval'],
      declinedPermissions: [],
      missingPermissions: [],
      pageFetchErrors: [],
      connectedBy: admin.userId,
      tokenCipher: encryptSecret('user-token'),
    })
    const page = await MetaPage.create({
      id: crypto.randomUUID(),
      companyId: admin.companyId,
      connectionId: connection.id,
      appProfileId: profile.id,
      pageId,
      name: `Page ${pageId}`,
      status: 'connected',
      tokenCipher: encryptSecret('page-token'),
      webhookSubscribed: true,
    })
    return { page, connection }
  }

  test('disabled config does not start the scheduler', () => {
    const timer = autoSync.startMetaAutoSyncScheduler({
      allowInTest: true,
      config: { enabled: false, intervalMinutes: 10, intervalMs: 10 * 60 * 1000 },
    })
    assert.equal(timer, null)
    assert.equal(autoSync.isMetaAutoSyncSchedulerRunning(), false)
  })

  test('enabled + 10 minute interval schedules with env-derived ms (not hardcoded)', () => {
    const calls = []
    const fakeSetInterval = (fn, ms) => {
      calls.push({ fn, ms })
      return { unref() {} }
    }
    const config = readMetaAutoSyncConfig({
      META_AUTO_SYNC_ENABLED: 'true',
      META_AUTO_SYNC_INTERVAL_MINUTES: '10',
    })
    const timer = autoSync.startMetaAutoSyncScheduler({
      allowInTest: true,
      config,
      setIntervalFn: fakeSetInterval,
    })
    assert.ok(timer)
    assert.equal(autoSync.isMetaAutoSyncSchedulerRunning(), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].ms, 10 * 60 * 1000)
    assert.equal(calls[0].ms, config.intervalMs)
  })

  test('enabled + 15 minute interval uses 15 * 60 * 1000 from config', () => {
    const calls = []
    const fakeSetInterval = (fn, ms) => {
      calls.push(ms)
      return { unref() {} }
    }
    const config = readMetaAutoSyncConfig({
      META_AUTO_SYNC_ENABLED: 'true',
      META_AUTO_SYNC_INTERVAL_MINUTES: '15',
    })
    autoSync.startMetaAutoSyncScheduler({
      allowInTest: true,
      config,
      setIntervalFn: fakeSetInterval,
    })
    assert.deepEqual(calls, [15 * 60 * 1000])
    assert.equal(calls[0], config.intervalMs)
  })

  test('tick enqueues sync jobs for connected pages when enabled path runs', async () => {
    const admin = await registerVerifiedAdmin()
    const { page } = await seedConnectedPage(admin, `pg-as-${Date.now()}`)
    const calls = []
    const result = await autoSync.runMetaAutoSyncTick({
      startPageLeadSync: async (auth, pageId, body) => {
        calls.push({ auth, pageId, body })
        return { id: 'job-fake', status: 'pending' }
      },
    })
    assert.equal(result.skipped, false)
    const match = calls.find((c) => c.pageId === page.id)
    assert.ok(match, 'expected enqueue for seeded page')
    assert.equal(match.auth.companyId, admin.companyId)
    assert.equal(match.auth.userId, admin.userId)
  })

  test('META_SYNC_AUTORUN remains independent of Auto Sync enable flag', () => {
    assert.equal(process.env.META_SYNC_AUTORUN, '0')
    const enabled = readMetaAutoSyncConfig({
      META_AUTO_SYNC_ENABLED: 'true',
      META_AUTO_SYNC_INTERVAL_MINUTES: '10',
    })
    assert.equal(enabled.enabled, true)
    assert.equal(autoSync.syncJobsWorkerAutorunEnabled(), false)
  })
})
