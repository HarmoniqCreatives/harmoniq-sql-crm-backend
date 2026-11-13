const { DataTypes } = require('sequelize')

/**
 * Per-company sequence counters (e.g. lead numbers).
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineCounter(sequelize) {
  return sequelize.define('Counter', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    key: { type: DataTypes.STRING(64), allowNull: false },
    value: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'counters',
  })
}

module.exports = { defineCounter }
