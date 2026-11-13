const { DataTypes } = require('sequelize')
const { metaModes } = require('../utils/enums')

/**
 * Per-company Meta app configuration.
 * `customer` mode stores encrypted App Secret; `central` uses env credentials.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineMetaAppProfile(sequelize) {
  return sequelize.define('MetaAppProfile', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    mode: { type: DataTypes.ENUM(...Object.values(metaModes)), allowNull: false },
    label: { type: DataTypes.STRING(120), allowNull: false },
    appId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    appSecretCipher: { type: DataTypes.JSON, allowNull: true },
    secretStored: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: { type: DataTypes.CHAR(36), allowNull: false },
    updatedBy: { type: DataTypes.CHAR(36), allowNull: false },
  }, {
    tableName: 'meta_app_profiles',
  })
}

module.exports = { defineMetaAppProfile }
