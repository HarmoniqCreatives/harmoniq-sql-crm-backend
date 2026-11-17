const { DataTypes } = require('sequelize')

/**
 * Normalized Meta WhatsApp templates synced per company WABA.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppTemplate(sequelize) {
  return sequelize.define('WhatsAppTemplate', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    wabaId: { type: DataTypes.STRING(64), allowNull: false },
    metaId: { type: DataTypes.STRING(64), allowNull: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    language: { type: DataTypes.STRING(16), allowNull: false },
    category: { type: DataTypes.STRING(64), allowNull: true },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PENDING' },
    quality: { type: DataTypes.STRING(32), allowNull: true },
    rejectionReason: { type: DataTypes.STRING(500), allowNull: true },
    components: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    bodyVariableKeys: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, { tableName: 'whatsapp_templates' })
}

module.exports = { defineWhatsAppTemplate }
