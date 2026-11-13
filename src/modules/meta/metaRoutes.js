const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { createKeyedLimiter } = require('../../middleware/rateLimit')
const { permissionKeys } = require('../../utils/enums')
const {
  deleteProfile,
  getAvailablePages,
  getConnections,
  getLeadCounts,
  getOAuthCallback,
  getPages,
  getProfiles,
  getSyncJob,
  patchProfile,
  postConnectionPages,
  postDisconnectConnection,
  postDisconnectPage,
  postOAuthStart,
  postProfile,
  postSyncPage,
} = require('./metaController')

/**
 * Authenticated Meta Integration routes.
 * companyId always comes from requireAuth. OAuth callback is public (state-bound).
 */
const metaOAuthLimiter = createKeyedLimiter({
  prefix: 'meta-oauth',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  identity: (req) => (req.auth && req.auth.userId) || (req.query && req.query.state) || '',
})

const metaRouter = express.Router()

metaRouter.get('/oauth/callback', metaOAuthLimiter, asyncHandler(getOAuthCallback))

metaRouter.use(requireAuth)

metaRouter.get('/profiles', requirePermission(permissionKeys.metaView), asyncHandler(getProfiles))
metaRouter.post('/profiles', requirePermission(permissionKeys.metaManage), asyncHandler(postProfile))
metaRouter.patch('/profiles/:id', requirePermission(permissionKeys.metaManage), asyncHandler(patchProfile))
metaRouter.delete('/profiles/:id', requirePermission(permissionKeys.metaManage), asyncHandler(deleteProfile))

metaRouter.get(
  '/connections',
  requirePermission(permissionKeys.metaView),
  asyncHandler(getConnections),
)
metaRouter.post(
  '/connections/:id/disconnect',
  requirePermission(permissionKeys.metaManage),
  asyncHandler(postDisconnectConnection),
)
metaRouter.get(
  '/connections/:id/available-pages',
  requirePermission(permissionKeys.metaPagesManage),
  asyncHandler(getAvailablePages),
)
metaRouter.post(
  '/connections/:id/pages',
  requirePermission(permissionKeys.metaPagesManage),
  asyncHandler(postConnectionPages),
)

metaRouter.get('/pages', requirePermission(permissionKeys.metaView), asyncHandler(getPages))
metaRouter.get(
  '/lead-counts',
  requirePermission(permissionKeys.metaView),
  asyncHandler(getLeadCounts),
)
metaRouter.post(
  '/pages/:id/disconnect',
  requirePermission(permissionKeys.metaPagesManage),
  asyncHandler(postDisconnectPage),
)
metaRouter.post(
  '/pages/:id/sync',
  requirePermission(permissionKeys.metaPagesManage),
  asyncHandler(postSyncPage),
)
metaRouter.get(
  '/pages/:id/sync-jobs/:jobId',
  requirePermission(permissionKeys.metaPagesManage),
  asyncHandler(getSyncJob),
)

metaRouter.post(
  '/oauth/start',
  requirePermission(permissionKeys.metaManage),
  metaOAuthLimiter,
  asyncHandler(postOAuthStart),
)

module.exports = { metaRouter }
