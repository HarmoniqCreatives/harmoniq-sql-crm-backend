const { v4: uuidv4 } = require('uuid')
const modelsApi = require('../models')
const { devicePlatforms } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const notificationHub = require('./notificationHub')
const { queueDeliveriesForNotification } = require('./notificationPushService')

/**
 * Inbox + device-token APIs. Tenant always from auth — never trust client companyId.
 */

function getModels() {
  return modelsApi.getModels()
}

function presentNotification(row) {
  if (!row) return null
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row
  return {
    id: plain.id,
    category: plain.category,
    title: plain.title,
    body: plain.body,
    data: plain.data || null,
    entityType: plain.entityType || null,
    entityId: plain.entityId || null,
    href: plain.data && plain.data.href ? plain.data.href : (
      plain.entityType === 'lead' && plain.entityId
        ? `/leads/${plain.entityId}`
        : null
    ),
    readAt: plain.readAt || null,
    createdAt: plain.createdAt,
  }
}

async function listNotifications(auth, query = {}) {
  const { Notification } = getModels()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20))
  const unreadOnly = String(query.unreadOnly || '') === '1' || query.unreadOnly === true
  const where = {
    companyId: auth.companyId,
    userId: auth.userId,
  }
  if (unreadOnly) {
    where.readAt = null
  }
  const { rows, count } = await Notification.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    offset: (page - 1) * limit,
    limit,
  })
  return {
    notifications: rows.map(presentNotification),
    page,
    limit,
    total: count,
  }
}

async function getUnreadCount(auth) {
  const { Notification } = getModels()
  const unreadCount = await Notification.count({
    where: {
      companyId: auth.companyId,
      userId: auth.userId,
      readAt: null,
    },
  })
  return { unreadCount }
}

async function markNotificationRead(auth, notificationId) {
  const { Notification } = getModels()
  const row = await Notification.findOne({
    where: {
      id: String(notificationId || ''),
      companyId: auth.companyId,
      userId: auth.userId,
    },
  })
  if (!row) {
    throw new AppError(errors.notificationNotFound, 404)
  }
  if (!row.readAt) {
    row.readAt = new Date()
    await row.save()
    notificationHub.publishToUser(auth.companyId, auth.userId, {
      type: 'notification.read',
      notificationId: row.id,
      unreadCount: (await getUnreadCount(auth)).unreadCount,
    })
  }
  return { notification: presentNotification(row) }
}

async function markAllNotificationsRead(auth) {
  const { Notification } = getModels()
  const now = new Date()
  const [updated] = await Notification.update(
    { readAt: now },
    {
      where: {
        companyId: auth.companyId,
        userId: auth.userId,
        readAt: null,
      },
    },
  )
  notificationHub.publishToUser(auth.companyId, auth.userId, {
    type: 'notification.read_all',
    updated,
    unreadCount: 0,
  })
  return { updated, unreadCount: 0 }
}

const MAX_DEVICE_TOKEN_LENGTH = 512

/**
 * Upserts a device push token for the authenticated user.
 * Stores FCM or Expo tokens in expoPushToken column (no silent truncation).
 */
async function registerDeviceToken(auth, body = {}) {
  const token = String(body.token || body.expoPushToken || body.fcmToken || '').trim()
  if (!token || token.length < 20) {
    throw new AppError(errors.deviceTokenRequired, 400)
  }
  if (token.length > MAX_DEVICE_TOKEN_LENGTH) {
    throw new AppError(errors.deviceTokenTooLong, 400)
  }
  const platform = String(body.platform || '').trim().toLowerCase()
  if (!Object.values(devicePlatforms).includes(platform)) {
    throw new AppError(errors.devicePlatformInvalid, 400)
  }
  const { UserDeviceToken } = getModels()
  const deviceId = body.deviceId ? String(body.deviceId).slice(0, 128) : null
  const appVersion = body.appVersion ? String(body.appVersion).slice(0, 32) : null
  const now = new Date()

  let row = await UserDeviceToken.findOne({ where: { expoPushToken: token } })
  if (row) {
    if (row.companyId !== auth.companyId) {
      throw new AppError(errors.forbidden, 403)
    }
    // Same-tenant reclaim of another user's token is not allowed.
    if (row.userId !== auth.userId) {
      throw new AppError(errors.forbidden, 403)
    }
    row.platform = platform
    row.deviceId = deviceId
    row.appVersion = appVersion
    row.isActive = true
    row.lastSeenAt = now
    await row.save()
  } else if (deviceId) {
    row = await UserDeviceToken.findOne({
      where: {
        companyId: auth.companyId,
        userId: auth.userId,
        deviceId,
      },
    })
    if (row) {
      row.expoPushToken = token
      row.platform = platform
      row.appVersion = appVersion
      row.isActive = true
      row.lastSeenAt = now
      await row.save()
    }
  }
  if (!row) {
    row = await UserDeviceToken.create({
      id: uuidv4(),
      companyId: auth.companyId,
      userId: auth.userId,
      expoPushToken: token,
      platform,
      deviceId,
      appVersion,
      isActive: true,
      lastSeenAt: now,
    })
  }
  return {
    device: {
      id: row.id,
      platform: row.platform,
      deviceId: row.deviceId,
      isActive: row.isActive,
      lastSeenAt: row.lastSeenAt,
    },
  }
}

async function deactivateDeviceToken(auth, body = {}) {
  const { UserDeviceToken } = getModels()
  const token = String(body.token || body.expoPushToken || body.fcmToken || '').trim()
  const deviceId = body.deviceId ? String(body.deviceId).trim() : ''
  if (!token && !deviceId) {
    throw new AppError(errors.deviceIdentifierRequired, 400)
  }
  const where = {
    companyId: auth.companyId,
    userId: auth.userId,
    isActive: true,
  }
  if (token) {
    where.expoPushToken = token
  } else {
    where.deviceId = deviceId
  }
  const [updated] = await UserDeviceToken.update({ isActive: false }, { where })
  return { updated }
}

/**
 * Best-effort SSE publish for a newly created notification.
 * When verifyPersisted is true (post-commit hook), skip if the row is gone —
 * guards Sequelize 6.37.8 afterCommit-on-failed-commit behavior.
 *
 * @param {{ created?: boolean, notification?: object }} result
 * @param {{ verifyPersisted?: boolean }} [options]
 */
async function emitNotificationCreatedSse(result, options = {}) {
  if (!result || !result.created || !result.notification) {
    return result
  }
  const notification = result.notification
  if (options.verifyPersisted) {
    const { Notification } = getModels()
    const persisted = await Notification.findOne({
      where: {
        id: notification.id,
        companyId: notification.companyId,
        userId: notification.userId,
      },
    })
    if (!persisted) {
      return result
    }
  }
  try {
    const unread = await getUnreadCount({
      companyId: notification.companyId,
      userId: notification.userId,
    })
    notificationHub.publishToUser(notification.companyId, notification.userId, {
      type: 'notification.created',
      notification: presentNotification(notification),
      unreadCount: unread.unreadCount,
    })
  } catch (_error) {
    // SSE is best-effort.
  }
  return result
}

/**
 * After a notification row is created outside a transaction: SSE + durable push queue.
 * Transactional creates queue inside createNotification and only SSE via afterCommit.
 */
async function afterNotificationCreated(result) {
  if (!result || !result.created || !result.notification) {
    return result
  }
  const notification = result.notification
  await emitNotificationCreatedSse(result)
  try {
    const queued = await queueDeliveriesForNotification(notification)
    if (queued && queued.queued === 0) {
      // No eligible devices, or all rows already existed — per-device reconcile covers gaps.
    }
  } catch (error) {
    // SSE already attempted. Push queue failure must not lose the in-app row;
    // reconcileMissingPushDeliveries recovers missing delivery rows.
    console.error(JSON.stringify({
      event: 'notification_push_queue_failed',
      notificationId: notification.id,
      companyId: notification.companyId,
      userId: notification.userId,
      message: String(error && error.message ? error.message : error),
    }))
  }
  return result
}

module.exports = {
  presentNotification,
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  registerDeviceToken,
  deactivateDeviceToken,
  emitNotificationCreatedSse,
  afterNotificationCreated,
}
