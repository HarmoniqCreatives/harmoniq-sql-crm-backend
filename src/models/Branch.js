const { DataTypes } = require('sequelize')

/**
 * Lightweight company branch used for user assignment filters.
 * Full Branch Management UI is out of scope; rows must share the user's companyId.
 *
 * Unique: (companyId, nameKey)
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {import('sequelize').ModelStatic}
 */
function defineBranch(sequelize) {
  return sequelize.define('Branch', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    nameKey: { type: DataTypes.STRING(140), allowNull: false },
    timezone: { type: DataTypes.STRING(64), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'branches',
  })
}

module.exports = { defineBranch }
