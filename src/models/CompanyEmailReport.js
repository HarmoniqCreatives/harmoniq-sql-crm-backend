const { DataTypes } = require('sequelize')
const {
  emailReportFrequencies,
  emailReportMonthlySchedules,
  emailReportTypes,
} = require('../utils/enums')

/**
 * Per-company scheduled Automatic Email Report configuration.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineCompanyEmailReport(sequelize) {
  return sequelize.define('CompanyEmailReport', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    reportType: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: emailReportTypes.leadReport,
    },
    recipients: { type: DataTypes.JSON, allowNull: false },
    sendHour: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 9 },
    sendMinute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sendMeridiem: { type: DataTypes.STRING(2), allowNull: false, defaultValue: 'AM' },
    frequency: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: emailReportFrequencies.daily,
    },
    monthlySchedule: {
      type: DataTypes.STRING(16),
      allowNull: true,
      defaultValue: null,
      validate: {
        isValid(value) {
          if (value === null || value === undefined || value === '') {
            return
          }
          if (!Object.values(emailReportMonthlySchedules).includes(value)) {
            throw new Error('Invalid monthlySchedule')
          }
        },
      },
    },
    isDeleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
    deletedBy: { type: DataTypes.CHAR(36), allowNull: true },
  }, {
    tableName: 'company_email_reports',
    defaultScope: {
      where: { isDeleted: false },
    },
    scopes: {
      withDeleted: { where: {} },
      onlyDeleted: { where: { isDeleted: true } },
    },
  })
}

module.exports = { defineCompanyEmailReport }
