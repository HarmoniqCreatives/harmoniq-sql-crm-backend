'use strict'

/**
 * Phase 1 — Lead List enhancements foundation.
 * Adds Meta original lead generation time and campaign effective status on leads.
 * Does not backfill data (backfill is a later approved step).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const leads = await queryInterface.describeTable('leads')

    if (!leads.metaCreatedAt) {
      await queryInterface.addColumn('leads', 'metaCreatedAt', {
        type: Sequelize.DATE,
        allowNull: true,
        after: 'metaLeadId',
      })
    }

    if (!leads.campaignStatus) {
      await queryInterface.addColumn('leads', 'campaignStatus', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: '',
        after: 'campaignName',
      })
    }

    const indexes = await queryInterface.showIndex('leads')
    const hasMetaCreatedIndex = indexes.some(
      (index) => index.name === 'leads_company_meta_created_at_idx',
    )
    if (!hasMetaCreatedIndex) {
      await queryInterface.addIndex('leads', ['companyId', 'metaCreatedAt'], {
        name: 'leads_company_meta_created_at_idx',
      })
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('leads')
    const hasMetaCreatedIndex = indexes.some(
      (index) => index.name === 'leads_company_meta_created_at_idx',
    )
    if (hasMetaCreatedIndex) {
      await queryInterface.removeIndex('leads', 'leads_company_meta_created_at_idx')
    }

    const leads = await queryInterface.describeTable('leads')
    if (leads.campaignStatus) {
      await queryInterface.removeColumn('leads', 'campaignStatus')
    }
    if (leads.metaCreatedAt) {
      await queryInterface.removeColumn('leads', 'metaCreatedAt')
    }
  },
}
