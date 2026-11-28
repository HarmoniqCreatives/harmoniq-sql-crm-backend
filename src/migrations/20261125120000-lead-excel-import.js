'use strict'

/**
 * Excel bulk lead import — new lead provenance fields, note author display name,
 * and company-scoped import session storage.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('lead_import_sessions', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      userId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      originalFilename: { type: Sequelize.STRING(255), allowNull: false },
      fileSizeBytes: { type: Sequelize.INTEGER, allowNull: false },
      mimeType: { type: Sequelize.STRING(128), allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'uploaded' },
      rowCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      headersJson: { type: Sequelize.JSON, allowNull: true },
      mappingJson: { type: Sequelize.JSON, allowNull: true },
      rowsJson: { type: Sequelize.JSON, allowNull: true },
      validationSummaryJson: { type: Sequelize.JSON, allowNull: true },
      decisionsJson: { type: Sequelize.JSON, allowNull: true },
      resultsJson: { type: Sequelize.JSON, allowNull: true },
      errorMessage: { type: Sequelize.STRING(500), allowNull: true },
      idempotencyKey: { type: Sequelize.STRING(191), allowNull: true },
      confirmToken: { type: Sequelize.STRING(64), allowNull: true },
      completedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('lead_import_sessions', ['companyId', 'createdAt'], {
      name: 'lead_import_sessions_company_created_idx',
    })
    await queryInterface.addIndex('lead_import_sessions', ['companyId', 'userId'], {
      name: 'lead_import_sessions_company_user_idx',
    })
    await queryInterface.addIndex('lead_import_sessions', ['companyId', 'idempotencyKey'], {
      unique: true,
      name: 'lead_import_sessions_company_idempotency_uidx',
    })

    await queryInterface.addColumn('leads', 'entryMethod', {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'manual',
    })
    await queryInterface.addColumn('leads', 'importSessionId', {
      type: Sequelize.CHAR(36),
      allowNull: true,
      references: { model: 'lead_import_sessions', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    })
    await queryInterface.addColumn('leads', 'alternatePhone', {
      type: Sequelize.STRING(32),
      allowNull: true,
    })
    await queryInterface.addColumn('leads', 'subSource', {
      type: Sequelize.STRING(120),
      allowNull: true,
    })
    await queryInterface.addColumn('leads', 'agencyName', {
      type: Sequelize.STRING(200),
      allowNull: true,
    })
    await queryInterface.addColumn('leads', 'statusReason', {
      type: Sequelize.STRING(300),
      allowNull: true,
    })
    await queryInterface.addColumn('leads', 'receivedOn', {
      type: Sequelize.DATE,
      allowNull: true,
    })
    await queryInterface.addIndex('leads', ['companyId', 'entryMethod'], {
      name: 'leads_company_entry_method_idx',
    })
    await queryInterface.addIndex('leads', ['companyId', 'importSessionId'], {
      name: 'leads_company_import_session_idx',
    })
    await queryInterface.addIndex('leads', ['companyId', 'phone'], {
      name: 'leads_company_phone_idx',
    })

    await queryInterface.addColumn('lead_notes', 'authorDisplayName', {
      type: Sequelize.STRING(120),
      allowNull: true,
    })
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('lead_notes', 'authorDisplayName')
    await queryInterface.removeIndex('leads', 'leads_company_phone_idx')
    await queryInterface.removeIndex('leads', 'leads_company_import_session_idx')
    await queryInterface.removeIndex('leads', 'leads_company_entry_method_idx')
    await queryInterface.removeColumn('leads', 'receivedOn')
    await queryInterface.removeColumn('leads', 'statusReason')
    await queryInterface.removeColumn('leads', 'agencyName')
    await queryInterface.removeColumn('leads', 'subSource')
    await queryInterface.removeColumn('leads', 'alternatePhone')
    await queryInterface.removeColumn('leads', 'importSessionId')
    await queryInterface.removeColumn('leads', 'entryMethod')
    await queryInterface.dropTable('lead_import_sessions')
  },
}
