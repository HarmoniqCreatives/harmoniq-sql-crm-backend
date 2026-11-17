'use strict'

/**
 * Meta Lead Ads default assignee (company-scoped).
 *
 * ON DELETE SET NULL: if the configured user is removed, imports continue unassigned.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('companies')
    if (!table.metaDefaultAssigneeUserId) {
      await queryInterface.addColumn('companies', 'metaDefaultAssigneeUserId', {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        after: 'status',
      })
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('companies')
    if (table.metaDefaultAssigneeUserId) {
      await queryInterface.removeColumn('companies', 'metaDefaultAssigneeUserId')
    }
  },
}
