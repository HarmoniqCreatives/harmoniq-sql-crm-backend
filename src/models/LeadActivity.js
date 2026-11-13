const { DataTypes } = require('sequelize')

function defineLeadActivity(sequelize) {
  return sequelize.define('LeadActivity', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    leadId: { type: DataTypes.CHAR(36), allowNull: false },
    activityTypeId: { type: DataTypes.CHAR(36), allowNull: false },
    agentId: { type: DataTypes.CHAR(36), allowNull: false },
    scheduledAt: { type: DataTypes.DATE, allowNull: false },
    createdBy: { type: DataTypes.CHAR(36), allowNull: false },
  }, { tableName: 'lead_activities' })
}

module.exports = { defineLeadActivity }
