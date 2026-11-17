const { DataTypes } = require('sequelize')

/**
 * Idempotent webhook event receipts (dedupeKey unique).
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppWebhookEvent(sequelize) {
  return sequelize.define('WhatsAppWebhookEvent', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: true },
    dedupeKey: { type: DataTypes.STRING(191), allowNull: false },
    providerMessageId: { type: DataTypes.STRING(128), allowNull: true },
    eventType: { type: DataTypes.STRING(64), allowNull: false },
    payloadDigest: { type: DataTypes.CHAR(64), allowNull: true },
    processedAt: { type: DataTypes.DATE, allowNull: true },
    outcome: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'received' },
  }, { tableName: 'whatsapp_webhook_events' })
}

module.exports = { defineWhatsAppWebhookEvent }
