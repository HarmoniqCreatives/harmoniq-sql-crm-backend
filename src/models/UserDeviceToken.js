const { DataTypes } = require('sequelize')
const { devicePlatforms } = require('../utils/enums')

/**
 * Expo push device registration (Phase 0 schema only — no push send yet).
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineUserDeviceToken(sequelize) {
  return sequelize.define('UserDeviceToken', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    userId: { type: DataTypes.CHAR(36), allowNull: false },
    /** FCM or Expo token — widened to 512 (see migration 20261128120000). */
    expoPushToken: { type: DataTypes.STRING(512), allowNull: false },
    platform: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: {
        isIn: [Object.values(devicePlatforms)],
      },
    },
    deviceId: { type: DataTypes.STRING(128), allowNull: true },
    appVersion: { type: DataTypes.STRING(32), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastSeenAt: { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'user_device_tokens',
  })
}

module.exports = { defineUserDeviceToken }
