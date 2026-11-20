'use strict'

/**
 * Phase 3/4 — Structured Meta advertising metadata + enrichment status on leads.
 * Does not backfill or repair existing rows (Phase 5 is not approved).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const leads = await queryInterface.describeTable('leads')

    if (!leads.adId) {
      await queryInterface.addColumn('leads', 'adId', {
        type: Sequelize.STRING(128),
        allowNull: false,
        defaultValue: '',
        after: 'campaignStatus',
      })
    }
    if (!leads.adName) {
      await queryInterface.addColumn('leads', 'adName', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: '',
        after: 'adId',
      })
    }
    if (!leads.adSetId) {
      await queryInterface.addColumn('leads', 'adSetId', {
        type: Sequelize.STRING(128),
        allowNull: false,
        defaultValue: '',
        after: 'adName',
      })
    }
    if (!leads.adSetName) {
      await queryInterface.addColumn('leads', 'adSetName', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: '',
        after: 'adSetId',
      })
    }
    if (!leads.formId) {
      await queryInterface.addColumn('leads', 'formId', {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: '',
        after: 'adSetName',
      })
    }
    if (!leads.formName) {
      await queryInterface.addColumn('leads', 'formName', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: '',
        after: 'formId',
      })
    }
    if (!leads.metaEnrichmentStatus) {
      await queryInterface.addColumn('leads', 'metaEnrichmentStatus', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'not_applicable',
        after: 'facebookPageName',
      })
    }
    if (!leads.metaEnrichmentError) {
      await queryInterface.addColumn('leads', 'metaEnrichmentError', {
        type: Sequelize.STRING(80),
        allowNull: false,
        defaultValue: '',
        after: 'metaEnrichmentStatus',
      })
    }
  },

  async down(queryInterface) {
    const leads = await queryInterface.describeTable('leads')
    const columns = [
      'metaEnrichmentError',
      'metaEnrichmentStatus',
      'formName',
      'formId',
      'adSetName',
      'adSetId',
      'adName',
      'adId',
    ]
    for (const column of columns) {
      if (leads[column]) {
        await queryInterface.removeColumn('leads', column)
      }
    }
  },
}
