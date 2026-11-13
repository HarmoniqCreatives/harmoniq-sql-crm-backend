const { DataTypes } = require('sequelize')

/**
 * Single-use hashed OAuth state bound to company and user (10 minute TTL).
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineMetaOAuthState(sequelize) {
  return sequelize.define('MetaOAuthState', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    stateHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    userId: { type: DataTypes.CHAR(36), allowNull: false },
    appProfileId: { type: DataTypes.CHAR(36), allowNull: false },
    connectionId: { type: DataTypes.CHAR(36), allowNull: true },
    connectionLabel: { type: DataTypes.STRING(120), allowNull: false, defaultValue: '' },
    rerequest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'meta_oauth_states',
  })
}

module.exports = { defineMetaOAuthState }
