const { DataTypes } = require('sequelize')
const { notificationDeliveryStatuses, notificationProviders } = require('../utils/enums')

/**
 * Push delivery attempt log with claim/lease support for multi-instance workers.
 *
 * Unique: (notificationId, deviceTokenId)
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineNotificationDelivery(sequelize) {
  return sequelize.define('NotificationDelivery', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    notificationId: { type: DataTypes.CHAR(36), allowNull: false },
    deviceTokenId: { type: DataTypes.CHAR(36), allowNull: false },
    provider: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: notificationProviders.expo,
    },
    providerMessageId: { type: DataTypes.STRING(128), allowNull: true },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: notificationDeliveryStatuses.queued,
      validate: {
        isIn: [Object.values(notificationDeliveryStatuses)],
      },
    },
    errorCode: { type: DataTypes.STRING(64), allowNull: true },
    attempt: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sentAt: { type: DataTypes.DATE, allowNull: true },
    lockToken: { type: DataTypes.CHAR(36), allowNull: true },
    lockExpiresAt: { type: DataTypes.DATE, allowNull: true },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'notification_deliveries',
    indexes: [
      {
        unique: true,
        fields: ['notificationId', 'deviceTokenId'],
        name: 'notification_deliveries_notification_device_uidx',
      },
    ],
  })
}

module.exports = { defineNotificationDelivery }
