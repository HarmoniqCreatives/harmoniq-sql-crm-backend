const { DataTypes } = require('sequelize')

/**
 * Delivery / status audit for one WhatsApp send attempt.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppMessageLog(sequelize) {
  return sequelize.define('WhatsAppMessageLog', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    outboxId: { type: DataTypes.CHAR(36), allowNull: true },
    recipientPhone: { type: DataTypes.STRING(32), allowNull: false },
    recipientType: { type: DataTypes.STRING(32), allowNull: false },
    templateId: { type: DataTypes.CHAR(36), allowNull: true },
    templateName: { type: DataTypes.STRING(120), allowNull: false },
    language: { type: DataTypes.STRING(16), allowNull: false },
    workflowKey: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
    providerMessageId: { type: DataTypes.STRING(128), allowNull: true },
    idempotencyKey: { type: DataTypes.STRING(191), allowNull: false },
    lastError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    statusEvents: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
  }, { tableName: 'whatsapp_message_logs' })
}

module.exports = { defineWhatsAppMessageLog }
