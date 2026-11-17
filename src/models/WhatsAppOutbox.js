const { DataTypes } = require('sequelize')

/**
 * Durable send queue with lease fields for multi-instance workers.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppOutbox(sequelize) {
  return sequelize.define('WhatsAppOutbox', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    messageLogId: { type: DataTypes.CHAR(36), allowNull: false },
    recipientPhone: { type: DataTypes.STRING(32), allowNull: false },
    recipientType: { type: DataTypes.STRING(32), allowNull: false },
    templateName: { type: DataTypes.STRING(120), allowNull: false },
    language: { type: DataTypes.STRING(16), allowNull: false },
    templateParameters: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false },
    lockedAt: { type: DataTypes.DATE, allowNull: true },
    lockedBy: { type: DataTypes.STRING(128), allowNull: true },
    lockExpiresAt: { type: DataTypes.DATE, allowNull: true },
    lockToken: { type: DataTypes.CHAR(36), allowNull: true },
    idempotencyKey: { type: DataTypes.STRING(191), allowNull: false },
    lastError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    providerMessageId: { type: DataTypes.STRING(128), allowNull: true },
    workflowKey: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
  }, { tableName: 'whatsapp_outbox' })
}

module.exports = { defineWhatsAppOutbox }
