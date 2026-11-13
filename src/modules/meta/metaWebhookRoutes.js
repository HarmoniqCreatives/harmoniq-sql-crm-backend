const express = require('express')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { createKeyedLimiter } = require('../../middleware/rateLimit')
const { getWebhook, postWebhook } = require('./metaController')

/**
 * Public Meta webhook routes. Mount BEFORE express.json() so POST keeps raw bytes
 * for X-Hub-Signature-256 verification. Separate generous rate limit from login/OAuth.
 */
const metaWebhookLimiter = createKeyedLimiter({
  prefix: 'meta-webhook',
  windowMs: 60 * 1000,
  limit: 300,
  identity: (req) => req.ip || 'unknown',
})

const metaWebhookRouter = express.Router()

metaWebhookRouter.get('/webhook', metaWebhookLimiter, getWebhook)
metaWebhookRouter.post(
  '/webhook',
  metaWebhookLimiter,
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(postWebhook),
)

module.exports = { metaWebhookRouter }
