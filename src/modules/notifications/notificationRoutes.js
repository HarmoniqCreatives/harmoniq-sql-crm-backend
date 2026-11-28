const express = require('express')
const { requireAuth } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const {
  getNotifications,
  getNotificationsUnreadCount,
  postNotificationRead,
  postNotificationsReadAll,
  postNotificationDevice,
  postNotificationDeviceDeactivate,
  getNotificationStream,
} = require('./notificationController')

/**
 * Notification inbox + device tokens.
 * Authenticated user scope only — companyId from auth.
 */
const notificationRouter = express.Router()

notificationRouter.use(requireAuth)

notificationRouter.get('/stream', asyncHandler(getNotificationStream))
notificationRouter.get('/unread-count', asyncHandler(getNotificationsUnreadCount))
notificationRouter.get('/', asyncHandler(getNotifications))
notificationRouter.post('/read-all', asyncHandler(postNotificationsReadAll))
notificationRouter.post('/:id/read', asyncHandler(postNotificationRead))
notificationRouter.post('/devices', asyncHandler(postNotificationDevice))
notificationRouter.post('/devices/deactivate', asyncHandler(postNotificationDeviceDeactivate))

module.exports = { notificationRouter }
