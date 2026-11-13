const { DataTypes } = require('sequelize')

function defineLeadTransfer(sequelize) {
  return sequelize.define('LeadTransfer', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    leadId: { type: DataTypes.CHAR(36), allowNull: false },
    previousPrimaryAgentId: { type: DataTypes.CHAR(36), allowNull: true },
    primaryAgentId: { type: DataTypes.CHAR(36), allowNull: false },
    secondaryAgentId: { type: DataTypes.CHAR(36), allowNull: true },
    reason: { type: DataTypes.STRING(300), allowNull: false },
    transferredBy: { type: DataTypes.CHAR(36), allowNull: false },
  }, { tableName: 'lead_transfers' })
}

module.exports = { defineLeadTransfer }
