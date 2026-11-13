const { DataTypes } = require('sequelize')
const { companyStatuses } = require('../utils/enums')

/**
 * Root tenant record. All business tables hang off `companies.id`.
 *
 * Registration creates the company as `PENDING_VERIFICATION` until the
 * Super Admin verifies email. `nameKey` is unique for race-safe signup.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {import('sequelize').ModelStatic}
 */
function defineCompany(sequelize) {
  return sequelize.define('Company', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    nameKey: { type: DataTypes.STRING(180), allowNull: false, unique: true },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'Asia/Kolkata' },
    baseCurrency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'INR' },
    enabledCurrencies: { type: DataTypes.JSON, allowNull: false },
    logoUrl: { type: DataTypes.STRING(500), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    status: {
      type: DataTypes.ENUM(...Object.values(companyStatuses)),
      allowNull: false,
      defaultValue: companyStatuses.pendingVerification,
    },
  }, {
    tableName: 'companies',
  })
}

module.exports = { defineCompany }
