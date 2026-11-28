const { DataTypes } = require('sequelize')
const { catalogKinds } = require('../utils/enums')

function defineCatalogItem(sequelize) {
  return sequelize.define('CatalogItem', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    kind: { type: DataTypes.ENUM(...Object.values(catalogKinds)), allowNull: false },
    key: { type: DataTypes.STRING(64), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    tone: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'neutral' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isDeleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
    deletedBy: { type: DataTypes.CHAR(36), allowNull: true },
  }, {
    tableName: 'catalog_items',
    defaultScope: {
      where: { isDeleted: false },
    },
    scopes: {
      withDeleted: { where: {} },
      onlyDeleted: { where: { isDeleted: true } },
    },
  })
}

module.exports = { defineCatalogItem }
