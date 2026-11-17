'use strict'

/**
 * Lead page attribution for report grouping + Automatic Email Reports schema.
 *
 * ON DELETE:
 * - company_email_reports.companyId → companies CASCADE
 * - email_report_delivery_logs.companyId → companies CASCADE
 * - email_report_delivery_logs.reportId → company_email_reports SET NULL
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const leads = await queryInterface.describeTable('leads')
    if (!leads.facebookPageId) {
      await queryInterface.addColumn('leads', 'facebookPageId', {
        type: Sequelize.STRING(128),
        allowNull: false,
        defaultValue: '',
        after: 'campaignName',
      })
    }
    if (!leads.facebookPageName) {
      await queryInterface.addColumn('leads', 'facebookPageName', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: '',
        after: 'facebookPageId',
      })
    }

    const companies = await queryInterface.describeTable('companies')
    if (!companies.emailReportsEnabled) {
      await queryInterface.addColumn('companies', 'emailReportsEnabled', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'metaDefaultAssigneeUserId',
      })
    }

    await queryInterface.createTable('company_email_reports', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      reportType: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'lead_report' },
      recipients: { type: Sequelize.JSON, allowNull: false },
      sendHour: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 9 },
      sendMinute: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      sendMeridiem: { type: Sequelize.STRING(2), allowNull: false, defaultValue: 'AM' },
      frequency: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'daily' },
      monthlySchedule: { type: Sequelize.STRING(16), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('company_email_reports', ['companyId'], {
      name: 'company_email_reports_company_idx',
    })

    await queryInterface.createTable('email_report_delivery_logs', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      reportId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'company_email_reports', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      reportType: { type: Sequelize.STRING(64), allowNull: false },
      frequency: { type: Sequelize.STRING(16), allowNull: false },
      monthlySchedule: { type: Sequelize.STRING(16), allowNull: true },
      deliveryKey: { type: Sequelize.STRING(64), allowNull: false },
      reportingDate: { type: Sequelize.STRING(32), allowNull: false, defaultValue: '' },
      rangeStart: { type: Sequelize.DATE, allowNull: true },
      rangeEnd: { type: Sequelize.DATE, allowNull: true },
      recipients: { type: Sequelize.JSON, allowNull: false },
      attachments: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'processing' },
      errorMessage: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      lockedAt: { type: Sequelize.DATE, allowNull: true },
      lockExpiresAt: { type: Sequelize.DATE, allowNull: true },
      sentAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex(
      'email_report_delivery_logs',
      ['companyId', 'reportType', 'deliveryKey'],
      { unique: true, name: 'email_report_delivery_unique' },
    )
    await queryInterface.addIndex('email_report_delivery_logs', ['status', 'lockExpiresAt'], {
      name: 'email_report_delivery_lease_idx',
    })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('email_report_delivery_logs')
    await queryInterface.dropTable('company_email_reports')
    const companies = await queryInterface.describeTable('companies')
    if (companies.emailReportsEnabled) {
      await queryInterface.removeColumn('companies', 'emailReportsEnabled')
    }
    const leads = await queryInterface.describeTable('leads')
    if (leads.facebookPageName) {
      await queryInterface.removeColumn('leads', 'facebookPageName')
    }
    if (leads.facebookPageId) {
      await queryInterface.removeColumn('leads', 'facebookPageId')
    }
  },
}
