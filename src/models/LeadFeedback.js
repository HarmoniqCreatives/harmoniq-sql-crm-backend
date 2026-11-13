const { DataTypes } = require('sequelize')
const { feedbackTypes } = require('../utils/enums')

function defineLeadFeedback(sequelize) {
  return sequelize.define('LeadFeedback', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    leadId: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.ENUM(...Object.values(feedbackTypes)), allowNull: false, defaultValue: feedbackTypes.general },
    text: { type: DataTypes.STRING(2000), allowNull: false },
  }, { tableName: 'lead_feedbacks' })
}

module.exports = { defineLeadFeedback }
