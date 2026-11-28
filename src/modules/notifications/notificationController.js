const {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  registerDeviceToken,
  deactivateDeviceToken,
} = require('../../services/notificationInboxService')
const { subscribe } = require('../../services/notificationHub')

/** GET /api/notifications */
async function getNotifications(req, res) {
  const result = await listNotifications(req.auth, req.query)
  res.status(200).json({ data: result })
}

/** GET /api/notifications/unread-count */
async function getNotificationsUnreadCount(req, res) {
  const result = await getUnreadCount(req.auth)
  res.status(200).json({ data: result })
}

/** POST /api/notifications/:id/read */
async function postNotificationRead(req, res) {
  const result = await markNotificationRead(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

/** POST /api/notifications/read-all */
async function postNotificationsReadAll(req, res) {
  const result = await markAllNotificationsRead(req.auth)
  res.status(200).json({ data: result })
}

/** POST /api/notifications/devices */
async function postNotificationDevice(req, res) {
  const result = await registerDeviceToken(req.auth, req.body || {})
  res.status(200).json({ data: result })
}

/** DELETE /api/notifications/devices  OR POST /api/notifications/devices/deactivate */
async function postNotificationDeviceDeactivate(req, res) {
  const result = await deactivateDeviceToken(req.auth, req.body || {})
  res.status(200).json({ data: result })
}

/**
 * GET /api/notifications/stream — SSE for the authenticated user.
 * Keeps connection open; clients reconnect on drop.
 */
async function getNotificationStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)

  const unsubscribe = subscribe(req.auth.companyId, req.auth.userId, res)
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch (_error) {
      clearInterval(heartbeat)
      unsubscribe()
    }
  }, 25000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}

module.exports = {
  getNotifications,
  getNotificationsUnreadCount,
  postNotificationRead,
  postNotificationsReadAll,
  postNotificationDevice,
  postNotificationDeviceDeactivate,
  getNotificationStream,
}
