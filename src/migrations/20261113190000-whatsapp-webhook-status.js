'use strict'

/**
 * P4: webhook health fields on company WhatsApp config.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('whatsapp_company_configs', 'webhookLastEventAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'webhookLastError', {
      type: Sequelize.STRING(500),
      allowNull: false,
      defaultValue: '',
    })
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('whatsapp_company_configs', 'webhookLastError')
    await queryInterface.removeColumn('whatsapp_company_configs', 'webhookLastEventAt')
  },
}
