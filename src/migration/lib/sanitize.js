'use strict'

const SECRET_KEYS = new Set([
  'passwordHash',
  'password',
  'emailVerifyTokenHash',
  'resetTokenHash',
  'tokenHash',
  'accessToken',
  'refreshToken',
])

/**
 * Deep-clone plain data and redact secret fields for logs/reports.
 * @param {unknown} value
 */
function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) {
        out[key] = nested ? '[REDACTED]' : nested
      } else {
        out[key] = redactSecrets(nested)
      }
    }
    return out
  }
  return value
}

function summarizeUserForReport(user) {
  return {
    mongoId: user.mongoId || user._id,
    email: user.email,
    companyMongoId: user.companyMongoId || user.companyId,
    status: user.status,
    emailVerified: user.emailVerified,
    hasPasswordHash: Boolean(user.passwordHash),
  }
}

module.exports = {
  redactSecrets,
  summarizeUserForReport,
  SECRET_KEYS,
}
