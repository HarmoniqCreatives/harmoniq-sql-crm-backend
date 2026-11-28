'use strict'

/**
 * Push delivery reliability + FCM token width (additive / idempotent).
 *
 * For databases that already ran an older foundation migration without lease
 * columns / unique delivery index / 512-char tokens, this migration adds them.
 *
 * When foundation `20261124120000-notification-foundation.js` already created
 * these objects, describeTable / "already exists" handling makes this a no-op.
 *
 * DUPLICATE SAFETY:
 * - Does NOT silently DELETE duplicate delivery rows.
 * - If duplicates exist, unique-index creation fails with a clear diagnostic.
 * - Resolve duplicates with an approved dry-run/report before re-running.
 *
 * SAFETY: do not run against production until explicitly approved.
 * Do not execute this migration from the agent without separate approval.
 *
 * @type {import('sequelize-cli').Migration}
 */

function isAlreadyExistsError(error) {
  const message = String((error && error.message) || error || '')
  return /already exists|Duplicate key name|ER_DUP_KEYNAME/i.test(message)
}

function isMissingIndexError(error) {
  const message = String((error && error.message) || error || '')
  return /does not exist|Can't DROP|Unknown key|check that it exists/i.test(message)
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const deliveryTable = await queryInterface.describeTable('notification_deliveries')

    if (!deliveryTable.lockToken) {
      await queryInterface.addColumn('notification_deliveries', 'lockToken', {
        type: Sequelize.CHAR(36),
        allowNull: true,
        defaultValue: null,
      })
    }
    if (!deliveryTable.lockExpiresAt) {
      await queryInterface.addColumn('notification_deliveries', 'lockExpiresAt', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      })
    }
    if (!deliveryTable.nextAttemptAt) {
      await queryInterface.addColumn('notification_deliveries', 'nextAttemptAt', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      })
    }

    // Report duplicates — never auto-delete. Identical createdAt pairs would
    // survive a naive createdAt comparison DELETE and still break uniqueness.
    const [duplicates] = await queryInterface.sequelize.query(`
      SELECT notificationId, deviceTokenId, COUNT(*) AS duplicateCount
      FROM notification_deliveries
      GROUP BY notificationId, deviceTokenId
      HAVING COUNT(*) > 1
      LIMIT 25
    `)
    if (Array.isArray(duplicates) && duplicates.length > 0) {
      throw new Error(
        '[migration 20261128120000] Refusing to add unique '
        + '(notificationId, deviceTokenId): duplicate delivery rows exist. '
        + `Sample groups=${JSON.stringify(duplicates)}. `
        + 'Resolve duplicates with an approved dry-run/report, then re-run. '
        + 'No rows were deleted by this migration.',
      )
    }

    try {
      await queryInterface.addIndex(
        'notification_deliveries',
        ['notificationId', 'deviceTokenId'],
        {
          unique: true,
          name: 'notification_deliveries_notification_device_uidx',
        },
      )
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }
    }

    try {
      await queryInterface.addIndex('notification_deliveries', ['status', 'nextAttemptAt'], {
        name: 'notification_deliveries_status_next_attempt_idx',
      })
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }
    }

    const tokenTable = await queryInterface.describeTable('user_device_tokens')
    if (tokenTable.expoPushToken) {
      const typeString = String(
        (tokenTable.expoPushToken.type || tokenTable.expoPushToken.TYPE || ''),
      )
      // Widen when still at legacy 191 (or unknown). Idempotent if already 512.
      if (!/512/.test(typeString)) {
        await queryInterface.changeColumn('user_device_tokens', 'expoPushToken', {
          type: Sequelize.STRING(512),
          allowNull: false,
        })
      }
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeIndex(
        'notification_deliveries',
        'notification_deliveries_status_next_attempt_idx',
      )
    } catch (error) {
      if (!isMissingIndexError(error)) throw error
    }
    try {
      await queryInterface.removeIndex(
        'notification_deliveries',
        'notification_deliveries_notification_device_uidx',
      )
    } catch (error) {
      if (!isMissingIndexError(error)) throw error
    }

    const deliveryTable = await queryInterface.describeTable('notification_deliveries')
    if (deliveryTable.nextAttemptAt) {
      await queryInterface.removeColumn('notification_deliveries', 'nextAttemptAt')
    }
    if (deliveryTable.lockExpiresAt) {
      await queryInterface.removeColumn('notification_deliveries', 'lockExpiresAt')
    }
    if (deliveryTable.lockToken) {
      await queryInterface.removeColumn('notification_deliveries', 'lockToken')
    }

    // Do not narrow expoPushToken on down — tokens longer than 191 may exist.
  },
}
