const { DataTypes } = require('sequelize')

function defineLeadTag(sequelize) {
  return sequelize.define('LeadTag', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    leadId: { type: DataTypes.CHAR(36), allowNull: false },
    tagId: { type: DataTypes.CHAR(36), allowNull: false },
  }, { tableName: 'lead_tags' })
}

module.exports = { defineLeadTag }
