'use strict'

/**
 * Meta Integration Phase 1 schema (additive).
 *
 * ON DELETE choices:
 * - companyId → companies: CASCADE (tenant wipe removes Meta rows).
 * - appProfileId → meta_app_profiles: CASCADE on connections/oauth/pages owned by profile.
 * - connectionId → meta_connections: CASCADE for pages/forms owned by that connection.
 * - metaPageId → meta_pages: CASCADE for form subscriptions and webhook rows tied to the page.
 * - user FKs (createdBy/updatedBy/connectedBy/userId): RESTRICT (keep audit of who connected).
 * - Webhook ingestions keep companyId SET NULL only if company wiped separately — prefer CASCADE.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('meta_app_profiles', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      mode: { type: Sequelize.ENUM('central', 'customer'), allowNull: false },
      label: { type: Sequelize.STRING(120), allowNull: false },
      appId: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      appSecretCipher: { type: Sequelize.JSON, allowNull: true },
      secretStored: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdBy: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      updatedBy: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('meta_app_profiles', ['companyId'])
    await queryInterface.addIndex('meta_app_profiles', ['companyId', 'label'], {
      unique: true,
      name: 'meta_app_profiles_company_label_uq',
    })

    await queryInterface.createTable('meta_connections', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      appProfileId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'meta_app_profiles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      metaUserId: { type: Sequelize.STRING(64), allowNull: false },
      displayName: { type: Sequelize.STRING(255), allowNull: false, defaultValue: '' },
      connectionLabel: { type: Sequelize.STRING(120), allowNull: false, defaultValue: '' },
      tokenCipher: { type: Sequelize.JSON, allowNull: true },
      tokenExpiresAt: { type: Sequelize.DATE, allowNull: true },
      status: {
        type: Sequelize.ENUM('connected', 'disconnected', 'expired'),
        allowNull: false,
        defaultValue: 'connected',
      },
      grantedPermissions: { type: Sequelize.JSON, allowNull: false },
      declinedPermissions: { type: Sequelize.JSON, allowNull: false },
      missingPermissions: { type: Sequelize.JSON, allowNull: false },
      pageFetchErrors: { type: Sequelize.JSON, allowNull: false },
      connectedBy: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      lastVerifiedAt: { type: Sequelize.DATE, allowNull: true },
      disconnectedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('meta_connections', ['companyId'])
    await queryInterface.addIndex('meta_connections', ['companyId', 'appProfileId', 'metaUserId'], {
      unique: true,
      name: 'meta_connections_company_profile_user_uq',
    })

    await queryInterface.createTable('meta_pages', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      connectionId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'meta_connections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      appProfileId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'meta_app_profiles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      metaUserId: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      pageId: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(255), allowNull: false },
      tokenCipher: { type: Sequelize.JSON, allowNull: true },
      status: {
        type: Sequelize.ENUM('connected', 'disconnected', 'inaccessible', 'expired'),
        allowNull: false,
        defaultValue: 'connected',
      },
      webhookSubscribed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      subscriptionError: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      lastFetchedAt: { type: Sequelize.DATE, allowNull: true },
      lastError: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('meta_pages', ['companyId'])
    await queryInterface.addIndex('meta_pages', ['companyId', 'pageId'], {
      unique: true,
      name: 'meta_pages_company_page_uq',
    })
    await queryInterface.addIndex('meta_pages', ['connectionId'])
    await queryInterface.addIndex('meta_pages', ['pageId', 'status'], {
      name: 'meta_pages_page_status_idx',
    })

    await queryInterface.createTable('meta_lead_form_subscriptions', {
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
      connectionId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'meta_connections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      pageId: { type: Sequelize.STRING(64), allowNull: false },
      formId: { type: Sequelize.STRING(64), allowNull: false },
      formName: { type: Sequelize.STRING(255), allowNull: false, defaultValue: '' },
      status: {
        type: Sequelize.ENUM('active', 'inactive'),
        allowNull: false,
        defaultValue: 'active',
      },
      lastSeenAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('meta_lead_form_subscriptions', ['companyId'])
    await queryInterface.addIndex('meta_lead_form_subscriptions', ['companyId', 'pageId', 'formId'], {
      unique: true,
      name: 'meta_form_subs_company_page_form_uq',
    })

    await queryInterface.createTable('meta_oauth_states', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      stateHash: { type: Sequelize.STRING(64), allowNull: false },
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
      appProfileId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'meta_app_profiles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      connectionId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'meta_connections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      connectionLabel: { type: Sequelize.STRING(120), allowNull: false, defaultValue: '' },
      rerequest: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      usedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('meta_oauth_states', ['stateHash'], {
      unique: true,
      name: 'meta_oauth_states_hash_uq',
    })
    await queryInterface.addIndex('meta_oauth_states', ['companyId'])
    await queryInterface.addIndex('meta_oauth_states', ['expiresAt'])

    // companyId is NULL for ignored unknown-page events (no tenant association).
    await queryInterface.createTable('meta_webhook_ingestions', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      metaPageId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'meta_pages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      connectionId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'meta_connections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      pageId: { type: Sequelize.STRING(64), allowNull: false },
      leadgenId: { type: Sequelize.STRING(64), allowNull: false },
      formId: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      dedupeKey: { type: Sequelize.STRING(191), allowNull: false },
      status: {
        type: Sequelize.ENUM('received', 'pending', 'processing', 'imported', 'skipped', 'failed', 'ignored'),
        allowNull: false,
        defaultValue: 'received',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('meta_webhook_ingestions', ['companyId'])
    await queryInterface.addIndex('meta_webhook_ingestions', ['dedupeKey'], {
      unique: true,
      name: 'meta_webhook_ingestions_dedupe_uq',
    })
    await queryInterface.addIndex('meta_webhook_ingestions', ['companyId', 'pageId', 'leadgenId'], {
      unique: true,
      name: 'meta_webhook_ingestions_company_page_lead_uq',
    })
    await queryInterface.addIndex('meta_webhook_ingestions', ['status', 'createdAt'])
  },

  async down(queryInterface) {
    await queryInterface.dropTable('meta_webhook_ingestions')
    await queryInterface.dropTable('meta_oauth_states')
    await queryInterface.dropTable('meta_lead_form_subscriptions')
    await queryInterface.dropTable('meta_pages')
    await queryInterface.dropTable('meta_connections')
    await queryInterface.dropTable('meta_app_profiles')
  },
}
