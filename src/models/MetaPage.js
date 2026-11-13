const { DataTypes } = require('sequelize')
const { metaPageStatuses } = require('../utils/enums')

/**
 * Connected Facebook Page. Page tokens are encrypted separately from user tokens.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineMetaPage(sequelize) {
  return sequelize.define('MetaPage', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    connectionId: { type: DataTypes.CHAR(36), allowNull: false },
    appProfileId: { type: DataTypes.CHAR(36), allowNull: true },
    metaUserId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    pageId: { type: DataTypes.STRING(64), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    tokenCipher: { type: DataTypes.JSON, allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(metaPageStatuses)),
      allowNull: false,
      defaultValue: metaPageStatuses.connected,
    },
    webhookSubscribed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    subscriptionError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    lastFetchedAt: { type: DataTypes.DATE, allowNull: true },
    lastSyncAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
  }, {
    tableName: 'meta_pages',
  })
}

module.exports = { defineMetaPage }
