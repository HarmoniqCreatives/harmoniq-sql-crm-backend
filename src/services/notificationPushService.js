'use strict'

const { Op, QueryTypes } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const os = require('os')
const modelsApi = require('../models')
const {
  notificationProviders,
  notificationDeliveryStatuses,
  notificationPushMaxAttempts,
} = require('../utils/enums')
const firebaseAdminApi = require('../config/firebaseAdmin')

/**
 * Queues and sends push deliveries for a notification to all active devices.
 * One notification DB row → N delivery rows (one per active device).
 *
 * Reliability:
 * - Unique (notificationId, deviceTokenId) for idempotent queueing
 * - Atomic claim with lease + lockToken (SKIP LOCKED when available)
 * - Bounded retries with backoff
 * - Per-device reconciliation for missing (notificationId, deviceTokenId) pairs
 * - Late-registered devices excluded via device.createdAt <= notification.createdAt
 * - At-least-once external delivery: if the provider accepts a message and the
 *   worker crashes before DB finalization, a reclaimed lease may send again.
 *
 * Live modelsApi.getModels() binding keeps unit tests able to mock without DB.
 */

function getModels() {
  return modelsApi.getModels()
}

const WORKER_ID = `${os.hostname()}:${process.pid}:push`
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000
/** Provider wait must finish before lease expiry so reclaim cannot overlap in-flight sends. */
const PROVIDER_TIMEOUT_SAFETY_MARGIN_MS = 2_000
const DEFAULT_RECONCILE_LOOKBACK_HOURS = 24
const DEFAULT_RECONCILE_BATCH = 50
const MAX_TOKEN_LENGTH = 512

function readLeaseMs() {
  const raw = Number(process.env.NOTIFICATION_PUSH_LEASE_MS)
  if (Number.isFinite(raw) && raw >= 10_000) return raw
  return DEFAULT_LEASE_MS
}

/**
 * Effective provider timeout — always strictly less than the delivery lease.
 * Unsafe env combinations are clamped with a diagnostic (never silently honored).
 *
 * @returns {number}
 */
function readProviderTimeoutMs() {
  const leaseMs = readLeaseMs()
  const maxSafe = Math.max(1_000, leaseMs - PROVIDER_TIMEOUT_SAFETY_MARGIN_MS)
  const raw = Number(process.env.NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS)
  let requested = DEFAULT_PROVIDER_TIMEOUT_MS
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 55_000) {
    requested = raw
  } else if (Number.isFinite(raw)) {
    console.warn(JSON.stringify({
      event: 'notification_push_timeout_config_invalid',
      requestedMs: raw,
      usingDefaultMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      leaseMs,
    }))
  }

  let effective = requested
  if (effective > maxSafe) {
    console.warn(JSON.stringify({
      event: 'notification_push_timeout_clamped_below_lease',
      requestedMs: requested,
      leaseMs,
      safetyMarginMs: PROVIDER_TIMEOUT_SAFETY_MARGIN_MS,
      effectiveMs: maxSafe,
    }))
    effective = maxSafe
  }
  if (effective >= leaseMs) {
    // Defensive: lease floor 10s + margin 2s → maxSafe is always < lease when lease >= 10s.
    effective = Math.max(1_000, leaseMs - 1)
    console.warn(JSON.stringify({
      event: 'notification_push_timeout_forced_below_lease',
      leaseMs,
      effectiveMs: effective,
    }))
  }
  return effective
}

/**
 * @returns {{ leaseMs: number, timeoutMs: number, ok: boolean }}
 */
function getTimeoutLeaseInvariant() {
  const leaseMs = readLeaseMs()
  const timeoutMs = readProviderTimeoutMs()
  return {
    leaseMs,
    timeoutMs,
    ok: timeoutMs < leaseMs,
    safetyMarginMs: PROVIDER_TIMEOUT_SAFETY_MARGIN_MS,
  }
}

function readMaxAttempts() {
  const raw = Number(process.env.NOTIFICATION_PUSH_MAX_ATTEMPTS)
  if (Number.isInteger(raw) && raw >= 1 && raw <= 20) return raw
  return notificationPushMaxAttempts
}

function readReconcileLookbackHours() {
  const raw = Number(process.env.NOTIFICATION_PUSH_RECONCILE_LOOKBACK_HOURS)
  if (Number.isFinite(raw) && raw >= 1 && raw <= 168) return raw
  return DEFAULT_RECONCILE_LOOKBACK_HOURS
}

function readReconcileBatch() {
  const raw = Number(process.env.NOTIFICATION_PUSH_RECONCILE_BATCH)
  if (Number.isInteger(raw) && raw >= 1 && raw <= 200) return raw
  return DEFAULT_RECONCILE_BATCH
}

/**
 * Bounded exponential backoff before re-queue.
 * @param {number} attempt 1-based attempt count after failure
 * @returns {Date}
 */
function nextRetryAt(attempt) {
  const capped = Math.min(Math.max(1, attempt), 8)
  const seconds = Math.min(300, 15 * (2 ** (capped - 1)))
  return new Date(Date.now() + seconds * 1000)
}

function isExpoToken(token) {
  return String(token || '').startsWith('ExponentPushToken')
    || String(token || '').startsWith('ExpoPushToken')
}

function resolveProvider(device) {
  if (isExpoToken(device.expoPushToken)) {
    return notificationProviders.expo
  }
  return notificationProviders.fcm
}

/**
 * Allowlisted push data only — never phone, email, or arbitrary notification.data.
 */
function stringDataPayload(notification) {
  const href = String((notification.data && notification.data.href) || (
    notification.entityType === 'lead' && notification.entityId
      ? `/leads/${notification.entityId}`
      : ''
  ))
  const leadId = String(
    (notification.data && notification.data.leadId)
      || (notification.entityType === 'lead' ? notification.entityId : '')
      || '',
  )
  return {
    notificationId: String(notification.id || ''),
    category: String(notification.category || ''),
    entityType: String(notification.entityType || ''),
    entityId: String(notification.entityId || ''),
    href,
    leadId,
  }
}

/**
 * Only definitive "this device token is dead" FCM errors.
 * Never treat generic invalid-argument as token death.
 */
function isInvalidFcmError(error) {
  const code = String(error?.code || error?.errorInfo?.code || '')
  const message = String(error?.message || '')
  return /registration-token-not-registered|invalid-registration-token/i.test(code)
    || /NotRegistered|InvalidRegistration|Requested entity was not found/i.test(message)
}

/**
 * Expo device-token death only.
 * InvalidCredentials is an app/provider credential failure — retry, do NOT deactivate.
 */
function isInvalidExpoDeviceError(errMsg) {
  const message = String(errMsg || '')
  if (/InvalidCredentials/i.test(message)) {
    return false
  }
  return /DeviceNotRegistered|not a registered push/i.test(message)
}

function isUniqueConstraintError(error) {
  return Boolean(error && (
    error.name === 'SequelizeUniqueConstraintError'
    || error.parent?.code === 'ER_DUP_ENTRY'
    || /Duplicate entry|ER_DUP_ENTRY/i.test(String(error.message || ''))
  ))
}

/**
 * Detect unsupported SKIP LOCKED / lock syntax — do not treat arbitrary DB errors as unsupported.
 */
function isSkipLockedUnsupportedError(error) {
  const message = String((error && error.message) || error || '')
  const code = String(error?.parent?.code || error?.original?.code || '')
  return /skip.?locked|ER_PARSE_ERROR|syntax.*lock|unknown.*lock/i.test(message)
    || code === 'ER_PARSE_ERROR'
}

/**
 * fetch with AbortController timeout (Node 18+ global fetch).
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || '')))) {
      const timeoutError = new Error(`provider_timeout_${timeoutMs}ms`)
      timeoutError.code = 'PROVIDER_TIMEOUT'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Strongest reliable "device existed by notification time" signal on current schema:
 * `user_device_tokens.createdAt` (row insert time).
 *
 * Limitation: deactivate/reactivate flips `isActive` and refreshes `lastSeenAt` but
 * does not reset `createdAt`. A reactivated row keeps its original createdAt, so it
 * remains eligible for historical reconcile if it first existed before the
 * notification. A brand-new row after notification.createdAt is excluded.
 * There is no separate firstActivatedAt column — do not claim perfect history after
 * hard delete + re-register as a new row (correctly treated as a late device).
 *
 * @param {{ createdAt?: Date|string|null }} device
 * @param {{ createdAt?: Date|string|null }} notification
 * @returns {boolean}
 */
function deviceExistedAtNotificationTime(device, notification) {
  if (!notification || !notification.createdAt) {
    // Create-time queue before timestamps hydrate — allow active tokens.
    return true
  }
  if (!device || !device.createdAt) {
    return false
  }
  const deviceAt = new Date(device.createdAt).getTime()
  const notificationAt = new Date(notification.createdAt).getTime()
  if (!Number.isFinite(deviceAt) || !Number.isFinite(notificationAt)) {
    return false
  }
  return deviceAt <= notificationAt
}

/**
 * Insert one delivery row. Idempotent under unique (notificationId, deviceTokenId).
 * @returns {Promise<'queued'|'duplicate'|'error'>}
 */
async function insertDeliveryForDevice(notification, device, options = {}) {
  const { NotificationDelivery } = getModels()
  try {
    await NotificationDelivery.create({
      id: uuidv4(),
      notificationId: notification.id,
      deviceTokenId: device.id,
      provider: resolveProvider(device),
      status: notificationDeliveryStatuses.queued,
      attempt: 0,
      sentAt: null,
      lockToken: null,
      lockExpiresAt: null,
      nextAttemptAt: new Date(),
    }, { transaction: options.transaction || undefined })
    return 'queued'
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return 'duplicate'
    }
    throw error
  }
}

/**
 * Idempotent queue: one delivery row per (notification, device).
 * Only active tokens for the exact notification companyId + userId that existed
 * by notification.createdAt (when known).
 *
 * @param {object} notification
 * @param {{ transaction?: object }} [options] Pass the same open transaction used to
 *   create the notification so rollback removes both rows.
 */
async function queueDeliveriesForNotification(notification, options = {}) {
  if (!notification || !notification.id || !notification.userId || !notification.companyId) {
    return { queued: 0, skipped: 0 }
  }
  if (String(process.env.NOTIFICATION_PUSH_ENABLED || '1') === '0') {
    return { queued: 0, skipped: 0 }
  }
  const { UserDeviceToken } = getModels()
  const where = {
    companyId: notification.companyId,
    userId: notification.userId,
    isActive: true,
  }
  if (notification.createdAt) {
    where.createdAt = { [Op.lte]: notification.createdAt }
  }
  const devices = await UserDeviceToken.findAll({
    where,
    transaction: options.transaction || undefined,
  })
  let queued = 0
  let skipped = 0
  for (const device of devices) {
    if (device.companyId !== notification.companyId || device.userId !== notification.userId) {
      skipped += 1
      continue
    }
    if (!deviceExistedAtNotificationTime(device, notification)) {
      skipped += 1
      continue
    }
    try {
      const outcome = await insertDeliveryForDevice(notification, device, options)
      if (outcome === 'queued') queued += 1
      else skipped += 1
    } catch (error) {
      // One device must not block the rest (create path + reconcile).
      skipped += 1
      console.error(JSON.stringify({
        event: 'notification_push_queue_device_failed',
        notificationId: notification.id,
        deviceTokenId: device.id,
        companyId: notification.companyId,
        userId: notification.userId,
        message: String(error && error.message ? error.message : error),
      }))
    }
  }
  return { queued, skipped }
}

/**
 * Durable recovery: missing (notificationId, deviceTokenId) pairs in the lookback
 * window for active recipient devices that existed by notification.createdAt.
 * Does not recreate rows that already exist (any status — sent/failed/invalid/queued).
 * Idempotent via unique (notificationId, deviceTokenId).
 *
 * Lookback default: 24h (NOTIFICATION_PUSH_RECONCILE_LOOKBACK_HOURS).
 * Batch default: 50 missing pairs (NOTIFICATION_PUSH_RECONCILE_BATCH).
 */
async function reconcileMissingPushDeliveries(options = {}) {
  if (String(process.env.NOTIFICATION_PUSH_ENABLED || '1') === '0') {
    return { scanned: 0, queued: 0, skipped: 0 }
  }
  const lookbackHours = options.lookbackHours != null
    ? options.lookbackHours
    : readReconcileLookbackHours()
  const limit = options.limit != null ? options.limit : readReconcileBatch()
  const since = options.since || new Date(Date.now() - lookbackHours * 60 * 60 * 1000)

  const { sequelize } = getModels()
  const rows = await sequelize.query(`
    SELECT
      n.id AS notificationId,
      n.companyId AS companyId,
      n.userId AS userId,
      n.createdAt AS notificationCreatedAt,
      d.id AS deviceTokenId,
      d.expoPushToken AS expoPushToken,
      d.platform AS platform,
      d.createdAt AS deviceCreatedAt
    FROM notifications n
    INNER JOIN user_device_tokens d
      ON d.companyId = n.companyId
     AND d.userId = n.userId
     AND d.isActive = 1
     AND d.createdAt <= n.createdAt
    LEFT JOIN notification_deliveries nd
      ON nd.notificationId = n.id
     AND nd.deviceTokenId = d.id
    WHERE n.createdAt >= :since
      AND nd.id IS NULL
    ORDER BY n.createdAt ASC, d.id ASC
    LIMIT :limit
  `, {
    replacements: { since, limit: Number(limit) },
    type: QueryTypes.SELECT,
  })

  let queued = 0
  let skipped = 0
  for (const row of rows) {
    const notification = {
      id: row.notificationId,
      companyId: row.companyId,
      userId: row.userId,
      createdAt: row.notificationCreatedAt,
    }
    const device = {
      id: row.deviceTokenId,
      companyId: row.companyId,
      userId: row.userId,
      expoPushToken: row.expoPushToken,
      platform: row.platform,
      createdAt: row.deviceCreatedAt,
      isActive: true,
    }
    if (
      device.companyId !== notification.companyId
      || device.userId !== notification.userId
      || !deviceExistedAtNotificationTime(device, notification)
    ) {
      skipped += 1
      continue
    }
    try {
      const outcome = await insertDeliveryForDevice(notification, device)
      if (outcome === 'queued') queued += 1
      else skipped += 1
    } catch (error) {
      skipped += 1
      console.error(JSON.stringify({
        event: 'notification_push_reconcile_device_failed',
        notificationId: notification.id,
        deviceTokenId: device.id,
        companyId: notification.companyId,
        userId: notification.userId,
        message: String(error && error.message ? error.message : error),
      }))
    }
  }

  console.log(JSON.stringify({
    event: 'notification_push_reconcile',
    scanned: rows.length,
    queued,
    skipped,
    lookbackHours,
    since: since.toISOString(),
  }))

  return { scanned: rows.length, queued, skipped, lookbackHours }
}

async function sendExpoPush(device, notification) {
  const timeoutMs = readProviderTimeoutMs()
  let response
  try {
    response = await fetchWithTimeout('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: device.expoPushToken,
        title: notification.title,
        body: notification.body,
        data: stringDataPayload(notification),
        sound: 'default',
        channelId: 'filos-notifications',
      }),
    }, timeoutMs)
  } catch (error) {
    return {
      ok: false,
      errorCode: String(error.message || 'expo_timeout').slice(0, 64),
      invalid: false,
    }
  }
  const json = await response.json().catch(() => ({}))
  const ticket = Array.isArray(json.data) ? json.data[0] : json.data
  if (ticket && ticket.status === 'ok') {
    return { ok: true, providerMessageId: ticket.id || null }
  }
  const errMsg = ticket?.message || json.errors?.[0]?.message || `expo_http_${response.status}`
  return {
    ok: false,
    errorCode: String(errMsg).slice(0, 64),
    invalid: isInvalidExpoDeviceError(errMsg),
  }
}

/**
 * FCM Admin SDK (firebase-admin@13.x) `messaging.send(message, dryRun?)` has no
 * request-timeout / AbortSignal parameter. Application-level Promise.race bounds
 * how long the worker waits so the lease can expire cleanly; it does NOT cancel
 * the underlying HTTP/2 request. If the SDK later succeeds after our timeout,
 * a reclaimed lease may send again (at-least-once). Stale workers still cannot
 * finalize after lockToken reclaim.
 *
 * @see https://firebase.google.com/docs/reference/admin/node/firebase-admin.messaging.messaging.md
 */
async function sendFcmAdmin(device, notification) {
  const messaging = firebaseAdminApi.getFirebaseMessaging()
  if (!messaging) {
    return { ok: false, errorCode: 'fcm_admin_not_configured', invalid: false }
  }
  const data = stringDataPayload(notification)
  const platform = String(device.platform || '').toLowerCase()
  const message = {
    token: device.expoPushToken,
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'filos-notifications',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
          contentAvailable: true,
        },
      },
    },
  }
  if (platform === 'web') {
    const absoluteLink = data.href && String(data.href).startsWith('http')
      ? String(data.href)
      : undefined
    message.webpush = {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data,
      ...(absoluteLink ? { fcmOptions: { link: absoluteLink } } : {}),
    }
  }
  const timeoutMs = readProviderTimeoutMs()
  let timer = null
  try {
    const messageId = await Promise.race([
      messaging.send(message),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeoutError = new Error(`provider_timeout_${timeoutMs}ms`)
          timeoutError.code = 'PROVIDER_TIMEOUT'
          reject(timeoutError)
        }, timeoutMs)
      }),
    ])
    return { ok: true, providerMessageId: messageId || null }
  } catch (error) {
    return {
      ok: false,
      errorCode: String(error.code || error.message || 'fcm_send_failed').slice(0, 64),
      invalid: error && error.code === 'PROVIDER_TIMEOUT' ? false : isInvalidFcmError(error),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function sendFcmLegacy(device, notification) {
  const serverKey = String(process.env.FIREBASE_SERVER_KEY || '').trim()
  if (!serverKey) {
    return { ok: false, errorCode: 'fcm_not_configured', invalid: false }
  }
  const data = stringDataPayload(notification)
  const timeoutMs = readProviderTimeoutMs()
  let response
  try {
    response = await fetchWithTimeout('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        Authorization: `key=${serverKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: device.expoPushToken,
        priority: 'high',
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data,
      }),
    }, timeoutMs)
  } catch (error) {
    return {
      ok: false,
      errorCode: String(error.message || 'fcm_timeout').slice(0, 64),
      invalid: false,
    }
  }
  const json = await response.json().catch(() => ({}))
  if (response.ok && json.success >= 1) {
    return { ok: true, providerMessageId: json.multicast_id ? String(json.multicast_id) : null }
  }
  const errMsg = json.results?.[0]?.error || `fcm_http_${response.status}`
  const invalid = /NotRegistered|InvalidRegistration/i.test(String(errMsg))
  return { ok: false, errorCode: String(errMsg).slice(0, 64), invalid }
}

async function sendFcm(device, notification) {
  if (firebaseAdminApi.isFirebaseAdminConfigured()) {
    return sendFcmAdmin(device, notification)
  }
  return sendFcmLegacy(device, notification)
}

function buildDueDeliveryWhere(now) {
  return {
    [Op.or]: [
      {
        status: notificationDeliveryStatuses.queued,
        [Op.or]: [
          { nextAttemptAt: null },
          { nextAttemptAt: { [Op.lte]: now } },
        ],
      },
      {
        status: notificationDeliveryStatuses.processing,
        [Op.or]: [
          { lockExpiresAt: null },
          { lockExpiresAt: { [Op.lte]: now } },
        ],
      },
    ],
  }
}

/**
 * Atomically claims due delivery rows (queued or expired processing leases).
 * Prefer SKIP LOCKED; fallback still recovers expired processing rows.
 */
async function claimQueuedDeliveries(limit = 40) {
  const { sequelize, NotificationDelivery } = getModels()
  const now = new Date()
  const leaseMs = readLeaseMs()
  const claimed = []
  const dueWhere = buildDueDeliveryWhere(now)

  await sequelize.transaction(async (transaction) => {
    let rows = []
    try {
      rows = await NotificationDelivery.findAll({
        where: dueWhere,
        order: [['createdAt', 'ASC']],
        limit,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
        transaction,
      })
    } catch (error) {
      if (!isSkipLockedUnsupportedError(error)) {
        throw error
      }
      // Fallback without SKIP LOCKED — still includes expired processing leases.
      rows = await NotificationDelivery.findAll({
        where: dueWhere,
        order: [['createdAt', 'ASC']],
        limit,
        lock: transaction.LOCK.UPDATE,
        transaction,
      })
    }

    for (const row of rows) {
      const lockToken = uuidv4()
      const lockExpiresAt = new Date(Date.now() + leaseMs)
      const [updated] = await NotificationDelivery.update({
        status: notificationDeliveryStatuses.processing,
        lockToken,
        lockExpiresAt,
      }, {
        where: {
          id: row.id,
          [Op.or]: [
            {
              status: notificationDeliveryStatuses.queued,
              [Op.or]: [
                { nextAttemptAt: null },
                { nextAttemptAt: { [Op.lte]: now } },
              ],
            },
            {
              status: notificationDeliveryStatuses.processing,
              [Op.or]: [
                { lockExpiresAt: null },
                { lockExpiresAt: { [Op.lte]: now } },
              ],
            },
          ],
        },
        transaction,
      })
      if (!updated) continue
      await row.reload({ transaction })
      claimed.push(row)
    }
  })

  return claimed
}

/**
 * Extend lease while still holding lockToken (provider call in progress).
 */
async function renewDeliveryLease(delivery) {
  if (!delivery || !delivery.id || !delivery.lockToken) {
    return { renewed: false }
  }
  const { NotificationDelivery } = getModels()
  const lockExpiresAt = new Date(Date.now() + readLeaseMs())
  const [updated] = await NotificationDelivery.update({ lockExpiresAt }, {
    where: {
      id: delivery.id,
      lockToken: delivery.lockToken,
      status: notificationDeliveryStatuses.processing,
    },
  })
  if (updated) {
    delivery.lockExpiresAt = lockExpiresAt
  }
  return { renewed: updated > 0 }
}

async function finalizeDeliverySuccess(delivery, providerMessageId) {
  const { NotificationDelivery } = getModels()
  const [updated] = await NotificationDelivery.update({
    status: notificationDeliveryStatuses.sent,
    providerMessageId: providerMessageId || null,
    sentAt: new Date(),
    errorCode: null,
    lockToken: null,
    lockExpiresAt: null,
    nextAttemptAt: null,
  }, {
    where: {
      id: delivery.id,
      lockToken: delivery.lockToken,
      status: notificationDeliveryStatuses.processing,
    },
  })
  return { finalized: updated > 0 }
}

async function finalizeDeliveryFailure(delivery, result) {
  const { NotificationDelivery, UserDeviceToken } = getModels()
  const attempt = Number(delivery.attempt || 0) + 1
  const maxAttempts = readMaxAttempts()
  const lockWhere = {
    id: delivery.id,
    lockToken: delivery.lockToken,
    status: notificationDeliveryStatuses.processing,
  }

  if (result.invalid) {
    const [updated] = await NotificationDelivery.update({
      status: notificationDeliveryStatuses.invalidToken,
      errorCode: result.errorCode || 'invalid_token',
      attempt,
      lockToken: null,
      lockExpiresAt: null,
      nextAttemptAt: null,
    }, { where: lockWhere })
    if (updated && delivery.deviceTokenId) {
      await UserDeviceToken.update(
        { isActive: false },
        { where: { id: delivery.deviceTokenId } },
      )
    }
    return { permanent: true, finalized: updated > 0 }
  }

  if (attempt >= maxAttempts) {
    const [updated] = await NotificationDelivery.update({
      status: notificationDeliveryStatuses.failed,
      errorCode: result.errorCode || 'send_failed',
      attempt,
      lockToken: null,
      lockExpiresAt: null,
      nextAttemptAt: null,
    }, { where: lockWhere })
    return { permanent: true, finalized: updated > 0 }
  }

  const [updated] = await NotificationDelivery.update({
    status: notificationDeliveryStatuses.queued,
    errorCode: result.errorCode || 'send_failed',
    attempt,
    lockToken: null,
    lockExpiresAt: null,
    nextAttemptAt: nextRetryAt(attempt),
  }, { where: lockWhere })
  return { permanent: false, finalized: updated > 0 }
}

/**
 * Processes due deliveries with atomic claim (safe under multiple instances).
 * Provider send runs only while this worker still owns the lease (renew succeeds).
 * Uses module.exports for claim/renew/send so unit tests can mock without MySQL.
 */
async function processQueuedDeliveries(limit = 40) {
  const self = module.exports
  const { UserDeviceToken, Notification, NotificationDelivery } = getModels()
  const claimed = await self.claimQueuedDeliveries(limit)
  let sent = 0
  let failed = 0
  let requeued = 0
  let skippedLease = 0

  for (const delivery of claimed) {
    const device = await UserDeviceToken.findByPk(delivery.deviceTokenId)
    const notification = await Notification.findByPk(delivery.notificationId)

    if (!device || !device.isActive || !notification) {
      await NotificationDelivery.update({
        status: notificationDeliveryStatuses.failed,
        errorCode: 'missing_device_or_notification',
        attempt: Math.max(Number(delivery.attempt || 0) + 1, readMaxAttempts()),
        lockToken: null,
        lockExpiresAt: null,
        nextAttemptAt: null,
      }, {
        where: {
          id: delivery.id,
          lockToken: delivery.lockToken,
          status: notificationDeliveryStatuses.processing,
        },
      })
      failed += 1
      continue
    }

    if (
      device.companyId !== notification.companyId
      || device.userId !== notification.userId
    ) {
      await NotificationDelivery.update({
        status: notificationDeliveryStatuses.failed,
        errorCode: 'tenant_or_recipient_mismatch',
        attempt: Math.max(Number(delivery.attempt || 0) + 1, readMaxAttempts()),
        lockToken: null,
        lockExpiresAt: null,
        nextAttemptAt: null,
      }, {
        where: {
          id: delivery.id,
          lockToken: delivery.lockToken,
          status: notificationDeliveryStatuses.processing,
        },
      })
      failed += 1
      continue
    }

    const renewResult = await self.renewDeliveryLease(delivery)
    if (!renewResult || !renewResult.renewed) {
      // Ownership lost (reclaimed / wrong status / missing lockToken) — do not send.
      skippedLease += 1
      console.warn(JSON.stringify({
        event: 'notification_push_lease_renew_failed',
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        deviceTokenId: delivery.deviceTokenId,
        companyId: notification.companyId,
        userId: notification.userId,
        reason: 'lost_lock_or_not_processing',
      }))
      continue
    }

    let result
    try {
      if (delivery.provider === notificationProviders.expo || isExpoToken(device.expoPushToken)) {
        result = await self.sendExpoPush(device, notification)
      } else {
        result = await sendFcm(device, notification)
      }
    } catch (error) {
      result = {
        ok: false,
        errorCode: String(error.message || 'send_failed').slice(0, 64),
        invalid: false,
      }
    }

    if (result.ok) {
      const fin = await self.finalizeDeliverySuccess(delivery, result.providerMessageId)
      if (fin.finalized) sent += 1
    } else {
      const outcome = await self.finalizeDeliveryFailure(delivery, result)
      if (outcome.permanent) failed += 1
      else requeued += 1
    }
  }

  return { processed: claimed.length, sent, failed, requeued, skippedLease }
}

let pushTimer = null
let pushTickRunning = false
let reconcileCounter = 0

function startNotificationPushWorker() {
  if (process.env.NODE_ENV === 'test') return
  if (String(process.env.NOTIFICATION_PUSH_ENABLED || '1') === '0') return
  if (pushTimer) return
  const ms = Math.max(5000, Number(process.env.NOTIFICATION_PUSH_INTERVAL_MS) || 15000)
  const reconcileEvery = Math.max(1, Number(process.env.NOTIFICATION_PUSH_RECONCILE_EVERY_TICKS) || 4)
  pushTimer = setInterval(() => {
    if (pushTickRunning) return
    pushTickRunning = true
    const tick = async () => {
      await processQueuedDeliveries()
      reconcileCounter += 1
      if (reconcileCounter >= reconcileEvery) {
        reconcileCounter = 0
        await reconcileMissingPushDeliveries()
      }
    }
    tick()
      .catch((error) => {
        console.error('[notification-push]', error.message)
      })
      .finally(() => {
        pushTickRunning = false
      })
  }, ms)
  if (typeof pushTimer.unref === 'function') pushTimer.unref()
}

function stopNotificationPushWorker() {
  if (pushTimer) {
    clearInterval(pushTimer)
    pushTimer = null
  }
  pushTickRunning = false
  reconcileCounter = 0
}

module.exports = {
  WORKER_ID,
  MAX_TOKEN_LENGTH,
  PROVIDER_TIMEOUT_SAFETY_MARGIN_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  isExpoToken,
  resolveProvider,
  stringDataPayload,
  isInvalidFcmError,
  isInvalidExpoDeviceError,
  isSkipLockedUnsupportedError,
  isUniqueConstraintError,
  deviceExistedAtNotificationTime,
  nextRetryAt,
  readMaxAttempts,
  readLeaseMs,
  readProviderTimeoutMs,
  getTimeoutLeaseInvariant,
  fetchWithTimeout,
  insertDeliveryForDevice,
  queueDeliveriesForNotification,
  reconcileMissingPushDeliveries,
  claimQueuedDeliveries,
  renewDeliveryLease,
  finalizeDeliverySuccess,
  finalizeDeliveryFailure,
  processQueuedDeliveries,
  sendFcmAdmin,
  sendExpoPush,
  startNotificationPushWorker,
  stopNotificationPushWorker,
}
