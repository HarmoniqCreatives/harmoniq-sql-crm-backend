'use strict'

/**
 * Phase 0 — in-app notifications + device tokens + delivery attempt log.
 *
 * ON DELETE:
 * - company-scoped rows → companies CASCADE
 * - notifications.userId / user_device_tokens.userId → users CASCADE
 * - notification_deliveries → notifications / user_device_tokens CASCADE
 *
 * Unique:
 * - notifications (companyId, idempotencyKey)
 * - user_device_tokens.expoPushToken
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('notifications', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      userId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      category: { type: Sequelize.STRING(64), allowNull: false },
      title: { type: Sequelize.STRING(200), allowNull: false },
      body: { type: Sequelize.STRING(500), allowNull: false },
      data: { type: Sequelize.JSON, allowNull: true },
      entityType: { type: Sequelize.STRING(64), allowNull: true },
      entityId: { type: Sequelize.CHAR(36), allowNull: true },
      idempotencyKey: { type: Sequelize.STRING(191), allowNull: false },
      readAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('notifications', ['companyId', 'idempotencyKey'], {
      unique: true,
      name: 'notifications_company_idempotency_uidx',
    })
    await queryInterface.addIndex('notifications', ['userId', 'createdAt'], {
      name: 'notifications_user_created_idx',
    })
    await queryInterface.addIndex('notifications', ['userId', 'readAt'], {
      name: 'notifications_user_read_idx',
    })
    await queryInterface.addIndex('notifications', ['companyId', 'userId'], {
      name: 'notifications_company_user_idx',
    })

    await queryInterface.createTable('user_device_tokens', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      userId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // Width matches post-reliability migration; FCM web tokens can exceed 191.
      expoPushToken: { type: Sequelize.STRING(512), allowNull: false },
      platform: { type: Sequelize.STRING(16), allowNull: false },
      deviceId: { type: Sequelize.STRING(128), allowNull: true },
      appVersion: { type: Sequelize.STRING(32), allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      lastSeenAt: { type: Sequelize.DATE, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('user_device_tokens', ['expoPushToken'], {
      unique: true,
      name: 'user_device_tokens_expo_token_uidx',
    })
    await queryInterface.addIndex('user_device_tokens', ['userId', 'isActive'], {
      name: 'user_device_tokens_user_active_idx',
    })
    await queryInterface.addIndex('user_device_tokens', ['companyId', 'userId'], {
      name: 'user_device_tokens_company_user_idx',
    })

    await queryInterface.createTable('notification_deliveries', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      notificationId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'notifications', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      deviceTokenId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'user_device_tokens', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      provider: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'expo' },
      providerMessageId: { type: Sequelize.STRING(128), allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
      errorCode: { type: Sequelize.STRING(64), allowNull: true },
      attempt: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      sentAt: { type: Sequelize.DATE, allowNull: true },
      lockToken: { type: Sequelize.CHAR(36), allowNull: true },
      lockExpiresAt: { type: Sequelize.DATE, allowNull: true },
      nextAttemptAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('notification_deliveries', ['notificationId', 'deviceTokenId'], {
      unique: true,
      name: 'notification_deliveries_notification_device_uidx',
    })
    await queryInterface.addIndex('notification_deliveries', ['deviceTokenId'], {
      name: 'notification_deliveries_device_idx',
    })
    await queryInterface.addIndex('notification_deliveries', ['status', 'nextAttemptAt'], {
      name: 'notification_deliveries_status_next_attempt_idx',
    })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('notification_deliveries')
    await queryInterface.dropTable('user_device_tokens')
    await queryInterface.dropTable('notifications')
  },
}
