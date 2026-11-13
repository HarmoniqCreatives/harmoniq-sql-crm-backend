const { DataTypes } = require('sequelize')

function defineLeadNote(sequelize) {
  return sequelize.define('LeadNote', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    leadId: { type: DataTypes.CHAR(36), allowNull: false },
    text: { type: DataTypes.STRING(2000), allowNull: false },
    createdBy: { type: DataTypes.CHAR(36), allowNull: false },
  }, { tableName: 'lead_notes', updatedAt: true })
}

module.exports = { defineLeadNote }
