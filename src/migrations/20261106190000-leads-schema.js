'use strict'

/**
 * Lead Management Phase 2 schema.
 *
 * ON DELETE choices:
 * - Child rows of a lead (tags/notes/feedbacks/transfers/activities): CASCADE with lead.
 * - companyId refs: CASCADE (tenant wipe).
 * - statusId / activityTypeId / tagId → catalog_items: RESTRICT (block catalog delete while used).
 * - primary/secondary/agent/author user refs: SET NULL or RESTRICT where NOT NULL required;
 *   optional agents SET NULL; required createdBy/transferredBy/agentId RESTRICT.
 * - branchId/teamId: SET NULL.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('leads', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      number: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      phone: { type: Sequelize.STRING(32), allowNull: false },
      email: { type: Sequelize.STRING(255), allowNull: false, defaultValue: '' },
      source: {
        type: Sequelize.ENUM('manual', 'facebook', 'instagram', 'website'),
        allowNull: false,
        defaultValue: 'manual',
      },
      metaLeadId: { type: Sequelize.STRING(128), allowNull: true },
      campaignId: { type: Sequelize.STRING(128), allowNull: false, defaultValue: '' },
      campaignName: { type: Sequelize.STRING(255), allowNull: false, defaultValue: '' },
      statusId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'catalog_items', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      primaryAgentId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      secondaryAgentId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      branchId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      teamId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'teams', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      propertyType: {
        type: Sequelize.ENUM('apartment', 'villa', 'townhouse', 'studio'),
        allowNull: false,
        defaultValue: 'apartment',
      },
      purpose: {
        type: Sequelize.ENUM('buy', 'rent'),
        allowNull: false,
        defaultValue: 'buy',
      },
      location: { type: Sequelize.STRING(300), allowNull: false, defaultValue: '' },
      budget: { type: Sequelize.STRING(300), allowNull: false, defaultValue: '' },
      currency: { type: Sequelize.STRING(8), allowNull: false },
      builtUpArea: { type: Sequelize.STRING(300), allowNull: false, defaultValue: '' },
      carpetArea: { type: Sequelize.STRING(300), allowNull: false, defaultValue: '' },
      readiness: {
        type: Sequelize.ENUM('ready_to_move', 'under_construction'),
        allowNull: false,
        defaultValue: 'ready_to_move',
      },
      nextFollowUpAt: { type: Sequelize.DATE, allowNull: true },
      deletedAt: { type: Sequelize.DATE, allowNull: true },
      deletedBy: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })

    await queryInterface.addIndex('leads', ['companyId', 'number'], {
      unique: true,
      name: 'leads_company_number_unique',
    })
    // MySQL UNIQUE allows multiple NULLs for metaLeadId — non-Meta leads stay NULL.
    await queryInterface.addIndex('leads', ['companyId', 'metaLeadId'], {
      unique: true,
      name: 'leads_company_meta_lead_unique',
    })
    await queryInterface.addIndex('leads', ['companyId', 'statusId'], { name: 'leads_company_status_idx' })
    await queryInterface.addIndex('leads', ['companyId', 'primaryAgentId'], { name: 'leads_company_primary_agent_idx' })
    await queryInterface.addIndex('leads', ['companyId', 'secondaryAgentId'], { name: 'leads_company_secondary_agent_idx' })
    await queryInterface.addIndex('leads', ['companyId', 'branchId', 'teamId'], { name: 'leads_company_branch_team_idx' })
    await queryInterface.addIndex('leads', ['companyId', 'createdAt'], { name: 'leads_company_created_idx' })
    await queryInterface.addIndex('leads', ['companyId', 'deletedAt'], { name: 'leads_company_deleted_idx' })
    await queryInterface.addIndex('leads', ['companyId', 'source'], { name: 'leads_company_source_idx' })

    await queryInterface.createTable('lead_tags', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      leadId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      tagId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'catalog_items', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('lead_tags', ['leadId', 'tagId'], {
      unique: true,
      name: 'lead_tags_lead_tag_unique',
    })
    await queryInterface.addIndex('lead_tags', ['companyId', 'tagId'], { name: 'lead_tags_company_tag_idx' })

    await queryInterface.createTable('lead_notes', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      leadId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      text: { type: Sequelize.STRING(2000), allowNull: false },
      createdBy: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('lead_notes', ['leadId', 'createdAt'], { name: 'lead_notes_lead_created_idx' })
    await queryInterface.addIndex('lead_notes', ['companyId'], { name: 'lead_notes_company_idx' })

    await queryInterface.createTable('lead_feedbacks', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      leadId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      type: {
        type: Sequelize.ENUM('general', 'positive', 'concern', 'complaint', 'follow_up_outcome'),
        allowNull: false,
        defaultValue: 'general',
      },
      text: { type: Sequelize.STRING(2000), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('lead_feedbacks', ['leadId', 'createdAt'], { name: 'lead_feedbacks_lead_created_idx' })
    await queryInterface.addIndex('lead_feedbacks', ['companyId'], { name: 'lead_feedbacks_company_idx' })

    await queryInterface.createTable('lead_transfers', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      leadId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      previousPrimaryAgentId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      primaryAgentId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      secondaryAgentId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      reason: { type: Sequelize.STRING(300), allowNull: false },
      transferredBy: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('lead_transfers', ['leadId', 'createdAt'], { name: 'lead_transfers_lead_created_idx' })
    await queryInterface.addIndex('lead_transfers', ['companyId'], { name: 'lead_transfers_company_idx' })

    await queryInterface.createTable('lead_activities', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      leadId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      activityTypeId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'catalog_items', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      agentId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      scheduledAt: { type: Sequelize.DATE, allowNull: false },
      createdBy: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('lead_activities', ['leadId', 'scheduledAt'], { name: 'lead_activities_lead_scheduled_idx' })
    await queryInterface.addIndex('lead_activities', ['companyId'], { name: 'lead_activities_company_idx' })
    await queryInterface.addIndex('lead_activities', ['activityTypeId'], { name: 'lead_activities_type_idx' })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('lead_activities')
    await queryInterface.dropTable('lead_transfers')
    await queryInterface.dropTable('lead_feedbacks')
    await queryInterface.dropTable('lead_notes')
    await queryInterface.dropTable('lead_tags')
    await queryInterface.dropTable('leads')
  },
}
