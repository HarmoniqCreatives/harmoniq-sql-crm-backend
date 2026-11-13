const { DataTypes } = require('sequelize')
const { roleScopes } = require('../utils/enums')

/**
 * Company-scoped role with a JSON permission list.
 *
 * System roles (`isSystem`) cannot be deleted. Protected Super Admin
 * (`isProtected`) cannot have its authority stripped by other users.
 * Permissions are re-read from this row on every authenticated request so
 * JWT payloads never become a stale privilege cache.
 *
 * Unique: (companyId, key)
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {import('sequelize').ModelStatic}
 */
function defineRole(sequelize) {
  return sequelize.define('Role', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    key: { type: DataTypes.STRING(64), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    permissions: { type: DataTypes.JSON, allowNull: false },
    scope: {
      type: DataTypes.ENUM(...Object.values(roleScopes)),
      allowNull: false,
      defaultValue: roleScopes.company,
    },
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isProtected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    tableName: 'roles',
  })
}

module.exports = { defineRole }
