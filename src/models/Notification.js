const { DataTypes } = require('sequelize')
const { notificationCategories } = require('../utils/enums')

/**
 * In-app notification inbox row (Phase 0). Push delivery is tracked separately.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineNotification(sequelize) {
  return sequelize.define('Notification', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    userId: { type: DataTypes.CHAR(36), allowNull: false },
    category: {
      type: DataTypes.STRING(64),
      allowNull: false,
      validate: {
        isIn: [Object.values(notificationCategories)],
      },
    },
    title: { type: DataTypes.STRING(200), allowNull: false },
    body: { type: DataTypes.STRING(500), allowNull: false },
    data: { type: DataTypes.JSON, allowNull: true },
    entityType: { type: DataTypes.STRING(64), allowNull: true },
    entityId: { type: DataTypes.CHAR(36), allowNull: true },
    idempotencyKey: { type: DataTypes.STRING(191), allowNull: false },
    readAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'notifications',
  })
}

module.exports = { defineNotification }
