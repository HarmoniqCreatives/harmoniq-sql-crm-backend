'use strict'

/**
 * P6: template catalog sync metadata + Meta template id.
 * New templates default to disabled; existing rows keep their isEnabled values.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('whatsapp_templates', 'metaId', {
      type: Sequelize.STRING(64),
      allowNull: true,
    })
    await queryInterface.addIndex('whatsapp_templates', ['companyId', 'metaId'], {
      name: 'whatsapp_templates_company_meta_idx',
    })

    await queryInterface.changeColumn('whatsapp_templates', 'isEnabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    })

    await queryInterface.addColumn('whatsapp_company_configs', 'templatesLastSyncedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addColumn('whatsapp_company_configs', 'templatesSyncError', {
      type: Sequelize.STRING(500),
      allowNull: false,
      defaultValue: '',
    })
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('whatsapp_company_configs', 'templatesSyncError')
    await queryInterface.removeColumn('whatsapp_company_configs', 'templatesLastSyncedAt')
    await queryInterface.changeColumn('whatsapp_templates', 'isEnabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    })
    await queryInterface.removeIndex('whatsapp_templates', 'whatsapp_templates_company_meta_idx')
    await queryInterface.removeColumn('whatsapp_templates', 'metaId')
  },
}
