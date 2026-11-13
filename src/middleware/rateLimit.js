const crypto = require('crypto')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const { errors } = require('../utils/errors')

/**
 * Auth and invitation rate limiters.
 *
 * Invite/accept limiters key on `ip + hashed identity` so one abusive client
 * cannot exhaust the shared bucket for everyone. Responses include `Retry-After`.
 * `TRUST_PROXY_HOPS` must be an exact hop count (never `true`).
 */

function hashKeyPart(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16)
}

function createAuthLimiter(options) {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    limit: options.limit || 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_TEST !== '1',
    message: {
      data: null,
      error: { message: errors.rateLimited },
    },
  })
}

function createKeyedLimiter(options) {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    limit: options.limit || 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_TEST !== '1',
    keyGenerator: (req, res) => {
      const ip = ipKeyGenerator(req.ip || 'unknown')
      let identity = ''
      if (typeof options.identity === 'function') {
        identity = options.identity(req) || ''
      }
      return `${options.prefix || 'rl'}:${ip}:${hashKeyPart(identity)}`
    },
    handler: (req, res) => {
      const retryAfterSeconds = Math.ceil((options.windowMs || 15 * 60 * 1000) / 1000)
      res.set('Retry-After', String(retryAfterSeconds))
      res.status(429).json({
        data: null,
        error: { message: errors.rateLimited },
      })
    },
  })
}

const registerLimiter = createAuthLimiter({ windowMs: 60 * 60 * 1000, limit: 10 })
const loginLimiter = createAuthLimiter({ windowMs: 15 * 60 * 1000, limit: 30 })
const verifyLimiter = createAuthLimiter({ windowMs: 15 * 60 * 1000, limit: 20 })
const passwordLimiter = createAuthLimiter({ windowMs: 60 * 60 * 1000, limit: 10 })

const inviteCreateLimiter = createKeyedLimiter({
  prefix: 'invite',
  windowMs: 60 * 60 * 1000,
  limit: 30,
  identity: (req) => (req.body && req.body.email) || '',
})

const inviteResendLimiter = createKeyedLimiter({
  prefix: 'invite-resend',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  identity: (req) => req.params.id || '',
})

const inviteAcceptLimiter = createKeyedLimiter({
  prefix: 'invite-accept',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  identity: (req) => {
    const token = (req.body && req.body.token) || (req.query && req.query.token) || ''
    return String(token).slice(0, 12)
  },
})

module.exports = {
  registerLimiter,
  loginLimiter,
  verifyLimiter,
  passwordLimiter,
  inviteCreateLimiter,
  inviteResendLimiter,
  inviteAcceptLimiter,
  createKeyedLimiter,
}
