'use strict'

/**
 * Phase 2 — Meta Manual Sync Now.
 *
 * ON DELETE:
 * - meta_sync_jobs.companyId → companies CASCADE
 * - meta_sync_jobs.metaPageId → meta_pages CASCADE (jobs owned by the page)
 * - meta_sync_jobs.createdByUserId → users RESTRICT (audit who started sync)
 * - ingestion.leadId → leads SET NULL (keep ingestion history if lead soft-deleted hard later)
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('meta_pages', 'lastSyncAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })

    await queryInterface.addColumn('meta_webhook_ingestions', 'leadId', {
      type: Sequelize.CHAR(36),
      allowNull: true,
      references: { model: 'leads', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'retryCount', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'lastError', {
      type: Sequelize.STRING(500),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'nextAttemptAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'formName', {
      type: Sequelize.STRING(255),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'pageName', {
      type: Sequelize.STRING(255),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'campaignId', {
      type: Sequelize.STRING(128),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'campaignName', {
      type: Sequelize.STRING(255),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'adSetId', {
      type: Sequelize.STRING(128),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'adSetName', {
      type: Sequelize.STRING(255),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'adId', {
      type: Sequelize.STRING(128),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'adName', {
      type: Sequelize.STRING(255),
      allowNull: false,
      defaultValue: '',
    })
    await queryInterface.addColumn('meta_webhook_ingestions', 'facebookCreatedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addIndex('meta_webhook_ingestions', ['status', 'nextAttemptAt'], {
      name: 'meta_webhook_ingestions_status_attempt_idx',
    })

    await queryInterface.createTable('meta_sync_jobs', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      metaPageId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'meta_pages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      facebookPageId: { type: Sequelize.STRING(64), allowNull: false },
      createdByUserId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      status: {
        type: Sequelize.ENUM('pending', 'processing', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      since: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      formId: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      imported: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      skipped: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      pending: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      formsTotal: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      formsDone: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      leadsSeen: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      errorMessage: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      leaseOwner: { type: Sequelize.STRING(64), allowNull: true },
      startedAt: { type: Sequelize.DATE, allowNull: true },
      finishedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('meta_sync_jobs', ['companyId'])
    await queryInterface.addIndex('meta_sync_jobs', ['companyId', 'metaPageId', 'status'], {
      name: 'meta_sync_jobs_company_page_status_idx',
    })
    await queryInterface.addIndex('meta_sync_jobs', ['status', 'createdAt'], {
      name: 'meta_sync_jobs_status_created_idx',
    })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('meta_sync_jobs')
    await queryInterface.removeIndex('meta_webhook_ingestions', 'meta_webhook_ingestions_status_attempt_idx')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'facebookCreatedAt')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'adName')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'adId')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'adSetName')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'adSetId')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'campaignName')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'campaignId')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'pageName')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'formName')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'nextAttemptAt')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'lastError')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'retryCount')
    await queryInterface.removeColumn('meta_webhook_ingestions', 'leadId')
    await queryInterface.removeColumn('meta_pages', 'lastSyncAt')
  },
}
