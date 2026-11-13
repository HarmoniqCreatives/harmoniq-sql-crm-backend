const { DataTypes } = require('sequelize')

/**
 * Global dial-country catalog for registration/mobile capture.
 * Not tenant-scoped — shared reference data loaded from MySQL.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineDialCountry(sequelize) {
  return sequelize.define('DialCountry', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    code: { type: DataTypes.STRING(8), allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'dial_countries',
  })
}

module.exports = { defineDialCountry }
