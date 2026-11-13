const {
  connectSelectedPages,
  createProfile,
  disconnectConnection,
  disconnectPage,
  handleOAuthCallback,
  listAvailablePages,
  listConnections,
  listPages,
  listProfiles,
  removeProfile,
  startOAuth,
  updateProfile,
} = require('../../services/metaService')
const {
  getPageLeadSyncJob,
  listLeadCounts,
  startPageLeadSync,
} = require('../../services/metaLeadService')
const {
  acceptWebhookPayload,
  verifyWebhookChallenge,
  verifyWebhookSignature,
} = require('../../services/metaWebhookService')
const { errors } = require('../../utils/errors')
const { messages } = require('../../utils/messages')

async function getProfiles(req, res) {
  const profiles = await listProfiles(req.auth)
  res.status(200).json({ data: { profiles } })
}

async function postProfile(req, res) {
  const profile = await createProfile(req.auth, req.body)
  res.status(201).json({
    data: { message: messages.metaProfileCreated, profile },
  })
}

async function patchProfile(req, res) {
  const profile = await updateProfile(req.auth, req.params.id, req.body)
  res.status(200).json({
    data: { message: messages.metaProfileUpdated, profile },
  })
}

async function deleteProfile(req, res) {
  await removeProfile(req.auth, req.params.id)
  res.status(200).json({
    data: { message: messages.metaProfileRemoved },
  })
}

async function getConnections(req, res) {
  const connections = await listConnections(req.auth)
  res.status(200).json({ data: { connections } })
}

async function postDisconnectConnection(req, res) {
  const connection = await disconnectConnection(req.auth, req.params.id)
  res.status(200).json({
    data: { message: messages.metaConnectionDisconnected, connection },
  })
}

async function getAvailablePages(req, res) {
  const pages = await listAvailablePages(req.auth, req.params.id)
  res.status(200).json({ data: { pages } })
}

async function postConnectionPages(req, res) {
  const result = await connectSelectedPages(req.auth, req.params.id, req.body)
  res.status(200).json({
    data: { message: messages.metaPagesConnected, ...result },
  })
}

async function getPages(req, res) {
  const result = await listPages(req.auth, req.query)
  res.status(200).json({ data: result })
}

async function postDisconnectPage(req, res) {
  const page = await disconnectPage(req.auth, req.params.id)
  res.status(200).json({
    data: { message: messages.metaPageDisconnected, page },
  })
}

async function postOAuthStart(req, res) {
  const url = await startOAuth(req.auth, req.body)
  res.status(200).json({ data: { url } })
}

async function getOAuthCallback(req, res) {
  const redirectUrl = await handleOAuthCallback(req.query)
  res.redirect(302, redirectUrl)
}

function getWebhook(req, res) {
  const challenge = verifyWebhookChallenge(req.query)
  if (!challenge) {
    res.status(403).json({
      data: null,
      error: { message: errors.metaWebhookVerify },
    })
    return
  }
  res.status(200).type('text/plain').send(challenge)
}

async function postWebhook(req, res) {
  const accepted = await verifyWebhookSignature(req.body, req.get('x-hub-signature-256'))
  if (!accepted) {
    res.status(401).json({
      data: null,
      error: { message: errors.metaWebhookSignature },
    })
    return
  }
  let payload = null
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''))
  } catch {
    res.status(400).json({
      data: null,
      error: { message: errors.metaWebhookInvalid },
    })
    return
  }
  await acceptWebhookPayload(payload)
  res.status(200).json({ data: { ok: true } })
}

async function postSyncPage(req, res) {
  const job = await startPageLeadSync(req.auth, req.params.id, req.body || {})
  res.status(202).json({ data: job })
}

async function getSyncJob(req, res) {
  const job = await getPageLeadSyncJob(req.auth, req.params.id, req.params.jobId)
  res.status(200).json({ data: job })
}

async function getLeadCounts(req, res) {
  const counts = await listLeadCounts(req.auth)
  res.status(200).json({
    data: {
      imported: counts.imported,
      skipped: counts.skipped,
      pending: counts.pending,
      failed: counts.failed,
      pages: Object.fromEntries(
        Object.entries(counts.pages).map(([facebookPageId, value]) => [
          facebookPageId,
          {
            imported: value.imported || 0,
            skipped: value.skipped || 0,
            pending: value.pending || 0,
            failed: value.failed || 0,
          },
        ]),
      ),
    },
  })
}

module.exports = {
  deleteProfile,
  getAvailablePages,
  getConnections,
  getLeadCounts,
  getOAuthCallback,
  getPages,
  getProfiles,
  getSyncJob,
  getWebhook,
  patchProfile,
  postConnectionPages,
  postDisconnectConnection,
  postDisconnectPage,
  postOAuthStart,
  postProfile,
  postSyncPage,
  postWebhook,
}
