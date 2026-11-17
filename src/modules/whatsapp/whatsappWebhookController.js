const { errors } = require('../../utils/errors')
const {
  acceptWhatsAppWebhookPayload,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
} = require('../../services/whatsappWebhookService')

function getWhatsAppWebhook(req, res) {
  const challenge = verifyWhatsAppWebhookChallenge(req.query)
  if (!challenge) {
    res.status(403).json({
      data: null,
      error: { message: errors.whatsappWebhookVerify },
    })
    return
  }
  res.status(200).type('text/plain').send(challenge)
}

async function postWhatsAppWebhook(req, res) {
  const accepted = verifyWhatsAppWebhookSignature(req.body, req.get('x-hub-signature-256'))
  if (!accepted) {
    res.status(401).json({
      data: null,
      error: { message: errors.whatsappWebhookSignature },
    })
    return
  }

  let payload = null
  const rawBody = req.body
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''))
  } catch {
    res.status(400).json({
      data: null,
      error: { message: errors.whatsappWebhookInvalid },
    })
    return
  }

  // Same pattern as Lead Ads: verify+parse, process bounded work, then 200.
  // Status updates are fail-soft and must not throw past asyncHandler.
  let summary = { processed: 0, duplicates: 0, ignored: 0 }
  try {
    summary = await acceptWhatsAppWebhookPayload(payload, rawBody)
  } catch {
    summary = { processed: 0, duplicates: 0, ignored: 0, fault: true }
  }
  res.status(200).json({ data: { ok: true, ...summary } })
}

module.exports = {
  getWhatsAppWebhook,
  postWhatsAppWebhook,
}
