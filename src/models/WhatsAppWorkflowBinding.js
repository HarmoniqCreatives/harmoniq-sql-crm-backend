const { DataTypes } = require('sequelize')

/**
 * Maps workflow keys (meta_assign / transfer) to a company template row.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppWorkflowBinding(sequelize) {
  return sequelize.define('WhatsAppWorkflowBinding', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    workflowKey: { type: DataTypes.STRING(64), allowNull: false },
    templateId: { type: DataTypes.CHAR(36), allowNull: false },
  }, { tableName: 'whatsapp_workflow_bindings' })
}

module.exports = { defineWhatsAppWorkflowBinding }
