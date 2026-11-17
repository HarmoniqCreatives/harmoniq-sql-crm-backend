const {
  disconnectWhatsApp,
  getWhatsAppConfig,
  saveManualWhatsAppConfig,
  sendWhatsAppTestMessage,
  updateWhatsAppConfig,
  verifyWhatsAppConnection,
} = require('../../services/whatsappConfigService')
const {
  completeEmbeddedSignup,
  getEmbeddedSignupBootstrap,
  startEmbeddedSignup,
} = require('../../services/whatsappEmbeddedSignupService')
const {
  getRegistrationStatus,
  registerCompanyPhone,
  reconcileWhatsAppWebhookSubscription,
} = require('../../services/whatsappRegistrationService')
const { enqueueWhatsAppMessage } = require('../../services/whatsappOutboxService')
const {
  syncCompanyTemplates,
  listCompanyTemplates,
  updateCompanyTemplate,
  listWorkflowBindings,
  upsertWorkflowBinding,
} = require('../../services/whatsappTemplateCatalogService')
const { messages } = require('../../utils/messages')

function readRequestMeta(req) {
  return {
    ip: req.ip || null,
    requestId: req.get('x-request-id') || null,
  }
}

/** GET /api/whatsapp/config */
async function getConfig(req, res) {
  const config = await getWhatsAppConfig(req.auth)
  const embeddedSignup = getEmbeddedSignupBootstrap()
  res.status(200).json({ data: { config, embeddedSignup } })
}

/** PATCH /api/whatsapp/config */
async function patchConfig(req, res) {
  const config = await updateWhatsAppConfig(req.auth, req.body || {}, readRequestMeta(req))
  res.status(200).json({
    data: {
      message: messages.whatsappConfigUpdated,
      config,
    },
  })
}

/** PUT /api/whatsapp/config/manual — Manual Cloud API credentials */
async function putManualConfig(req, res) {
  const data = await saveManualWhatsAppConfig(req.auth, req.body || {}, readRequestMeta(req))
  res.status(200).json({ data })
}

/** POST /api/whatsapp/config/verify */
async function postVerify(req, res) {
  const data = await verifyWhatsAppConnection(req.auth, readRequestMeta(req))
  res.status(200).json({ data })
}

/** POST /api/whatsapp/config/test-message */
async function postTestMessage(req, res) {
  const data = await sendWhatsAppTestMessage(req.auth, req.body || {}, readRequestMeta(req))
  res.status(200).json({ data })
}

/** POST /api/whatsapp/disconnect */
async function postDisconnect(req, res) {
  const config = await disconnectWhatsApp(req.auth, readRequestMeta(req))
  res.status(200).json({
    data: {
      message: messages.whatsappDisconnected,
      config,
    },
  })
}

/** POST /api/whatsapp/embedded-signup/start */
async function postEmbeddedSignupStart(req, res) {
  const data = await startEmbeddedSignup(req.auth, readRequestMeta(req))
  res.status(200).json({ data })
}

/** POST /api/whatsapp/embedded-signup/complete */
async function postEmbeddedSignupComplete(req, res) {
  const data = await completeEmbeddedSignup(req.auth, req.body || {}, readRequestMeta(req))
  res.status(200).json({ data })
}

/** GET /api/whatsapp/registration-status */
async function getRegistration(req, res) {
  const config = await getRegistrationStatus(req.auth)
  res.status(200).json({
    data: {
      config,
      registration: {
        status: config.phoneRegistrationStatus,
        registeredAt: config.phoneRegisteredAt,
        error: config.phoneRegistrationError,
        wabaWebhookSubscribed: config.wabaWebhookSubscribed,
        messagingReady: config.messagingReady,
      },
    },
  })
}

/** POST /api/whatsapp/register */
async function postRegister(req, res) {
  const data = await registerCompanyPhone(req.auth, req.body || {}, readRequestMeta(req))
  res.status(200).json({ data })
}

/** POST /api/whatsapp/messages — authorized manual/test enqueue */
async function postMessage(req, res) {
  const data = await enqueueWhatsAppMessage(req.auth, req.body || {}, readRequestMeta(req))
  res.status(201).json({ data })
}

/** POST /api/whatsapp/webhook-subscription — reconcile WABA subscribed_apps */
async function postWebhookSubscription(req, res) {
  const data = await reconcileWhatsAppWebhookSubscription(req.auth, readRequestMeta(req))
  res.status(200).json({ data })
}

/** POST /api/whatsapp/templates/sync */
async function postTemplatesSync(req, res) {
  const data = await syncCompanyTemplates(req.auth, readRequestMeta(req))
  res.status(200).json({ data })
}

/** GET /api/whatsapp/templates */
async function getTemplates(req, res) {
  const data = await listCompanyTemplates(req.auth, req.query || {})
  res.status(200).json({ data })
}

/** PATCH /api/whatsapp/templates/:id */
async function patchTemplate(req, res) {
  const data = await updateCompanyTemplate(
    req.auth,
    req.params.id,
    req.body || {},
    readRequestMeta(req),
  )
  res.status(200).json({ data })
}

/** GET /api/whatsapp/workflow-bindings */
async function getWorkflowBindings(req, res) {
  const data = await listWorkflowBindings(req.auth)
  res.status(200).json({ data })
}

/** PUT /api/whatsapp/workflow-bindings/:workflowKey */
async function putWorkflowBinding(req, res) {
  const data = await upsertWorkflowBinding(
    req.auth,
    req.params.workflowKey,
    req.body || {},
    readRequestMeta(req),
  )
  res.status(200).json({ data })
}

module.exports = {
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
}
