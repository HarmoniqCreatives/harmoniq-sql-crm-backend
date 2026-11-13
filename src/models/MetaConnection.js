const { DataTypes } = require('sequelize')
const { metaConnectionStatuses } = require('../utils/enums')

/**
 * Facebook user account connected for a company Meta app profile.
 * User access tokens stay encrypted and are never returned by APIs.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineMetaConnection(sequelize) {
  return sequelize.define('MetaConnection', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    appProfileId: { type: DataTypes.CHAR(36), allowNull: false },
    metaUserId: { type: DataTypes.STRING(64), allowNull: false },
    displayName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    connectionLabel: { type: DataTypes.STRING(120), allowNull: false, defaultValue: '' },
    tokenCipher: { type: DataTypes.JSON, allowNull: true },
    tokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(metaConnectionStatuses)),
      allowNull: false,
      defaultValue: metaConnectionStatuses.connected,
    },
    grantedPermissions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    declinedPermissions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    missingPermissions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    pageFetchErrors: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    connectedBy: { type: DataTypes.CHAR(36), allowNull: false },
    lastVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    disconnectedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'meta_connections',
  })
}

module.exports = { defineMetaConnection }
