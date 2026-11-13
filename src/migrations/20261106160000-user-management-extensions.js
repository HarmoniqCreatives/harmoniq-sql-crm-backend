'use strict'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const invitationTable = await queryInterface.describeTable('invitations')

    if (!invitationTable.emailDelivery) {
      await queryInterface.addColumn('invitations', 'emailDelivery', {
        type: Sequelize.ENUM('pending', 'sent', 'failed'),
        allowNull: true,
        after: 'status',
      })
    }
    if (!invitationTable.emailError) {
      await queryInterface.addColumn('invitations', 'emailError', {
        type: Sequelize.STRING(80),
        allowNull: true,
        after: 'emailDelivery',
      })
    }

    // Unique token hash for single-use lookup (MySQL allows multiple NULLs).
    const [invitationIndexes] = await queryInterface.sequelize.query(
      "SHOW INDEX FROM invitations WHERE Key_name = 'invitations_token_hash_unique'",
    )
    if (!invitationIndexes.length) {
      await queryInterface.addIndex('invitations', ['tokenHash'], {
        unique: true,
        name: 'invitations_token_hash_unique',
      })
    }

    const [userEmailIndexes] = await queryInterface.sequelize.query(
      "SHOW INDEX FROM users WHERE Key_name = 'users_company_id_email_unique'",
    )
    if (!userEmailIndexes.length) {
      await queryInterface.addIndex('users', ['companyId', 'email'], {
        unique: true,
        name: 'users_company_id_email_unique',
      })
    }

    const [pendingInviteIndexes] = await queryInterface.sequelize.query(
      "SHOW INDEX FROM invitations WHERE Key_name = 'invitations_company_email_status_idx'",
    )
    if (!pendingInviteIndexes.length) {
      await queryInterface.addIndex('invitations', ['companyId', 'email', 'status'], {
        name: 'invitations_company_email_status_idx',
      })
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('invitations', 'invitations_token_hash_unique').catch(() => {})
    await queryInterface.removeColumn('invitations', 'emailError').catch(() => {})
    await queryInterface.removeColumn('invitations', 'emailDelivery').catch(() => {})
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS enum_invitations_emailDelivery').catch(() => {})
  },
}
