'use strict'

/**
 * Additive: company-level follow-up reminder lead time (minutes before nextFollowUpAt).
 * Allowlist enforced in app: 5, 10, 15, 25, 30, 60. Default 5.
 *
 * SAFETY: run only against isolated test DB unless separately approved for local.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('companies')
    if (!table.followUpReminderMinutes) {
      await queryInterface.addColumn('companies', 'followUpReminderMinutes', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 5,
      })
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('companies')
    if (table.followUpReminderMinutes) {
      await queryInterface.removeColumn('companies', 'followUpReminderMinutes')
    }
  },
}
