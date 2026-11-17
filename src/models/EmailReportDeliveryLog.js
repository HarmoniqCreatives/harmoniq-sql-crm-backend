const { DataTypes } = require('sequelize')
const { emailReportDeliveryStatuses } = require('../utils/enums')

/**
 * Idempotent delivery log for scheduled email reports (company + reportType + deliveryKey).
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineEmailReportDeliveryLog(sequelize) {
  return sequelize.define('EmailReportDeliveryLog', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    reportId: { type: DataTypes.CHAR(36), allowNull: true },
    reportType: { type: DataTypes.STRING(64), allowNull: false },
    frequency: { type: DataTypes.STRING(16), allowNull: false },
    monthlySchedule: { type: DataTypes.STRING(16), allowNull: true },
    deliveryKey: { type: DataTypes.STRING(64), allowNull: false },
    reportingDate: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '' },
    rangeStart: { type: DataTypes.DATE, allowNull: true },
    rangeEnd: { type: DataTypes.DATE, allowNull: true },
    recipients: { type: DataTypes.JSON, allowNull: false },
    attachments: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: emailReportDeliveryStatuses.processing,
    },
    errorMessage: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    lockedAt: { type: DataTypes.DATE, allowNull: true },
    lockExpiresAt: { type: DataTypes.DATE, allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'email_report_delivery_logs',
  })
}

module.exports = { defineEmailReportDeliveryLog }
