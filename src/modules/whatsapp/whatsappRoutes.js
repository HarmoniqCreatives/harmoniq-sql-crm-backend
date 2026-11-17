const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { createKeyedLimiter } = require('../../middleware/rateLimit')
const { permissionKeys } = require('../../utils/enums')
const {
  getConfig,
  patchConfig,
  putManualConfig,
  postVerify,
  postTestMessage,
  postDisconnect,
  postEmbeddedSignupStart,
  postEmbeddedSignupComplete,
  getRegistration,
  postRegister,
  postMessage,
  postWebhookSubscription,
  postTemplatesSync,
  getTemplates,
  patchTemplate,
  getWorkflowBindings,
  putWorkflowBinding,
} = require('./whatsappController')

/**
 * Authenticated WhatsApp Cloud API routes.
 * companyId always from requireAuth — never from the client body.
 */
const whatsappRouter = express.Router()

whatsappRouter.use(requireAuth)

const registerLimiter = createKeyedLimiter({
  prefix: 'wa-register',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  identity: (req) => (req.auth && req.auth.companyId) || '',
})

const messageEnqueueLimiter = createKeyedLimiter({
  prefix: 'wa-message',
  windowMs: 15 * 60 * 1000,
  limit: 30,
  identity: (req) => (req.auth && req.auth.companyId) || '',
})

whatsappRouter.get(
  '/config',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(getConfig),
)

whatsappRouter.patch(
  '/config',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(patchConfig),
)

whatsappRouter.put(
  '/config/manual',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(putManualConfig),
)

whatsappRouter.post(
  '/config/verify',
  requirePermission(permissionKeys.whatsappManage),
  registerLimiter,
  asyncHandler(postVerify),
)

whatsappRouter.post(
  '/config/test-message',
  requirePermission(permissionKeys.whatsappManage),
  messageEnqueueLimiter,
  asyncHandler(postTestMessage),
)

whatsappRouter.post(
  '/disconnect',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(postDisconnect),
)

whatsappRouter.post(
  '/embedded-signup/start',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(postEmbeddedSignupStart),
)

whatsappRouter.post(
  '/embedded-signup/complete',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(postEmbeddedSignupComplete),
)

whatsappRouter.get(
  '/registration-status',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(getRegistration),
)

whatsappRouter.post(
  '/register',
  requirePermission(permissionKeys.whatsappManage),
  registerLimiter,
  asyncHandler(postRegister),
)

whatsappRouter.post(
  '/messages',
  requirePermission(permissionKeys.whatsappManage),
  messageEnqueueLimiter,
  asyncHandler(postMessage),
)

whatsappRouter.post(
  '/webhook-subscription',
  requirePermission(permissionKeys.whatsappManage),
  registerLimiter,
  asyncHandler(postWebhookSubscription),
)

const templateSyncLimiter = createKeyedLimiter({
  prefix: 'wa-template-sync',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  identity: (req) => (req.auth && req.auth.companyId) || '',
})

whatsappRouter.post(
  '/templates/sync',
  requirePermission(permissionKeys.whatsappManage),
  templateSyncLimiter,
  asyncHandler(postTemplatesSync),
)

whatsappRouter.get(
  '/templates',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(getTemplates),
)

whatsappRouter.patch(
  '/templates/:id',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(patchTemplate),
)

whatsappRouter.get(
  '/workflow-bindings',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(getWorkflowBindings),
)

whatsappRouter.put(
  '/workflow-bindings/:workflowKey',
  requirePermission(permissionKeys.whatsappManage),
  asyncHandler(putWorkflowBinding),
)

module.exports = { whatsappRouter }
