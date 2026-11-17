const express = require('express')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { createKeyedLimiter } = require('../../middleware/rateLimit')
const {
  getWhatsAppWebhook,
  postWhatsAppWebhook,
} = require('./whatsappWebhookController')

/**
 * Public WhatsApp Cloud API webhook routes.
 * Mount BEFORE express.json() so POST keeps raw bytes for X-Hub-Signature-256.
 * Completely separate from Facebook Lead Ads /api/meta/webhook.
 */
const whatsappWebhookLimiter = createKeyedLimiter({
  prefix: 'wa-webhook',
  windowMs: 60 * 1000,
  limit: 300,
  identity: (req) => req.ip || 'unknown',
})

const whatsappWebhookRouter = express.Router()

whatsappWebhookRouter.get('/webhook', whatsappWebhookLimiter, getWhatsAppWebhook)
whatsappWebhookRouter.post(
  '/webhook',
  whatsappWebhookLimiter,
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(postWhatsAppWebhook),
)

module.exports = { whatsappWebhookRouter }
