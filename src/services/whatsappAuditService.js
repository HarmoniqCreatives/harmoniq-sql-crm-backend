const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')
const { whatsappAuditOutcomes } = require('../utils/enums')

/**
 * Strips secrets from audit detail strings before persistence.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeAuditDetail(value) {
  let text = value === undefined || value === null ? '' : String(value)
  text = text.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
  text = text.replace(/accessToken["']?\s*[:=]\s*["']?[^"'\s,]+/gi, 'accessToken=[redacted]')
  text = text.replace(/cipherText["']?\s*[:=]\s*["']?[^"'\s,]+/gi, 'cipherText=[redacted]')
  text = text.replace(/authorization[_\s-]?code["']?\s*[:=]\s*["']?[^"'\s,]+/gi, 'authorization_code=[redacted]')
  if (text.length > 500) {
    text = text.slice(0, 500)
  }
  return text
}

/**
 * Writes one WhatsApp audit row (never stores tokens/ciphertext).
 *
 * @param {object} details
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function writeWhatsAppAudit(details, options = {}) {
  const { WhatsAppAuditLog } = getModels()
  const transaction = options.transaction
  return WhatsAppAuditLog.create({
    id: uuidv4(),
    companyId: details.companyId,
    actorUserId: details.actorUserId || null,
    action: details.action,
    target: String(details.target || '').slice(0, 191),
    outcome: details.outcome || whatsappAuditOutcomes.success,
    ip: details.ip || null,
    requestId: details.requestId || null,
    detail: sanitizeAuditDetail(details.detail || ''),
  }, { transaction })
}

module.exports = {
  sanitizeAuditDetail,
  writeWhatsAppAudit,
}
