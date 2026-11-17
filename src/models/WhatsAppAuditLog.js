const { DataTypes } = require('sequelize')

/**
 * Sanitized WhatsApp admin/action audit trail (no secrets).
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppAuditLog(sequelize) {
  return sequelize.define('WhatsAppAuditLog', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    actorUserId: { type: DataTypes.CHAR(36), allowNull: true },
    action: { type: DataTypes.STRING(64), allowNull: false },
    target: { type: DataTypes.STRING(191), allowNull: false },
    outcome: { type: DataTypes.STRING(32), allowNull: false },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    requestId: { type: DataTypes.STRING(64), allowNull: true },
    detail: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
  }, { tableName: 'whatsapp_audit_logs' })
}

module.exports = { defineWhatsAppAuditLog }
