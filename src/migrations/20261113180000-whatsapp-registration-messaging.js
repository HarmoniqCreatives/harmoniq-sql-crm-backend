'use strict'

/**
 * P3: phone Cloud API registration status + WABA webhook subscription flags.
 * Lease columns already exist on whatsapp_outbox from the foundation migration.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('whatsapp_company_configs', 'phoneRegistrationStatus', {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'unregistered',
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'phoneRegisteredAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'phoneRegistrationError', {
      type: Sequelize.STRING(500),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'wabaWebhookSubscribed', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'wabaWebhookSubscribedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'registrationLockToken', {
      type: Sequelize.CHAR(36),
      allowNull: true,
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'registrationLockedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'registrationLockExpiresAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addIndex(
      'whatsapp_company_configs',
      ['companyId', 'phoneRegistrationStatus'],
      { name: 'whatsapp_company_configs_reg_status_idx' },
    )
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'whatsapp_company_configs',
      'whatsapp_company_configs_reg_status_idx',
    )
    await queryInterface.removeColumn('whatsapp_company_configs', 'registrationLockExpiresAt')
    await queryInterface.removeColumn('whatsapp_company_configs', 'registrationLockedAt')
    await queryInterface.removeColumn('whatsapp_company_configs', 'registrationLockToken')
    await queryInterface.removeColumn('whatsapp_company_configs', 'wabaWebhookSubscribedAt')
    await queryInterface.removeColumn('whatsapp_company_configs', 'wabaWebhookSubscribed')
    await queryInterface.removeColumn('whatsapp_company_configs', 'phoneRegistrationError')
    await queryInterface.removeColumn('whatsapp_company_configs', 'phoneRegisteredAt')
    await queryInterface.removeColumn('whatsapp_company_configs', 'phoneRegistrationStatus')
  },
}
