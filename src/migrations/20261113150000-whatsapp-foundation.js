'use strict'

/**
 * WhatsApp Cloud API P1 foundation tables.
 *
 * ON DELETE:
 * - company-scoped rows → companies CASCADE
 * - workflow_bindings.templateId → whatsapp_templates RESTRICT
 * - outbox.messageLogId → whatsapp_message_logs RESTRICT
 * - message_logs.templateId → whatsapp_templates SET NULL
 * - createdBy/updatedBy/actorUserId → users RESTRICT (nullable actor)
 *
 * Unique:
 * - one config per company
 * - wabaId and phoneNumberId globally unique when set (NULLs allowed after disconnect)
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('whatsapp_company_configs', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      wabaId: { type: Sequelize.STRING(64), allowNull: true },
      phoneNumberId: { type: Sequelize.STRING(64), allowNull: true },
      businessId: { type: Sequelize.STRING(64), allowNull: true },
      displayPhoneNumber: { type: Sequelize.STRING(32), allowNull: true },
      displayName: { type: Sequelize.STRING(160), allowNull: true },
      qualityRating: { type: Sequelize.STRING(32), allowNull: true },
      messagingLimitTier: { type: Sequelize.STRING(64), allowNull: true },
      accessTokenCipher: { type: Sequelize.TEXT, allowNull: true },
      accessTokenIv: { type: Sequelize.STRING(64), allowNull: true },
      accessTokenTag: { type: Sequelize.STRING(64), allowNull: true },
      keyVersion: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      tokenStored: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      tokenSource: { type: Sequelize.STRING(32), allowNull: true },
      tokenExpiresAt: { type: Sequelize.DATE, allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      defaultLanguage: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'en' },
      metaAssignEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      transferEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      connectedAt: { type: Sequelize.DATE, allowNull: true },
      lastError: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
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
    await queryInterface.addIndex('whatsapp_company_configs', ['companyId'], {
      unique: true,
      name: 'whatsapp_company_configs_company_uidx',
    })
    await queryInterface.addIndex('whatsapp_company_configs', ['wabaId'], {
      unique: true,
      name: 'whatsapp_company_configs_waba_uidx',
    })
    await queryInterface.addIndex('whatsapp_company_configs', ['phoneNumberId'], {
      unique: true,
      name: 'whatsapp_company_configs_phone_uidx',
    })

    await queryInterface.createTable('whatsapp_embedded_signup_sessions', {
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
        onDelete: 'RESTRICT',
      },
      nonceHash: { type: Sequelize.CHAR(64), allowNull: false },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      consumedAt: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      requestId: { type: Sequelize.STRING(64), allowNull: true },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('whatsapp_embedded_signup_sessions', ['nonceHash'], {
      unique: true,
      name: 'whatsapp_embedded_signup_nonce_uidx',
    })
    await queryInterface.addIndex(
      'whatsapp_embedded_signup_sessions',
      ['companyId', 'userId', 'status'],
      { name: 'whatsapp_embedded_signup_company_user_status_idx' },
    )
    await queryInterface.addIndex('whatsapp_embedded_signup_sessions', ['expiresAt'], {
      name: 'whatsapp_embedded_signup_expires_idx',
    })

    await queryInterface.createTable('whatsapp_templates', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      wabaId: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      language: { type: Sequelize.STRING(16), allowNull: false },
      category: { type: Sequelize.STRING(64), allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'PENDING' },
      quality: { type: Sequelize.STRING(32), allowNull: true },
      rejectionReason: { type: Sequelize.STRING(500), allowNull: true },
      components: { type: Sequelize.JSON, allowNull: false },
      bodyVariableKeys: { type: Sequelize.JSON, allowNull: false },
      lastSyncedAt: { type: Sequelize.DATE, allowNull: true },
      isEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex(
      'whatsapp_templates',
      ['companyId', 'wabaId', 'name', 'language'],
      { unique: true, name: 'whatsapp_templates_identity_uidx' },
    )
    await queryInterface.addIndex('whatsapp_templates', ['companyId', 'status'], {
      name: 'whatsapp_templates_company_status_idx',
    })

    await queryInterface.createTable('whatsapp_workflow_bindings', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      workflowKey: { type: Sequelize.STRING(64), allowNull: false },
      templateId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'whatsapp_templates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex(
      'whatsapp_workflow_bindings',
      ['companyId', 'workflowKey'],
      { unique: true, name: 'whatsapp_workflow_bindings_uidx' },
    )

    await queryInterface.createTable('whatsapp_message_logs', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      outboxId: { type: Sequelize.CHAR(36), allowNull: true },
      recipientPhone: { type: Sequelize.STRING(32), allowNull: false },
      recipientType: { type: Sequelize.STRING(32), allowNull: false },
      templateId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'whatsapp_templates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      templateName: { type: Sequelize.STRING(120), allowNull: false },
      language: { type: Sequelize.STRING(16), allowNull: false },
      workflowKey: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
      providerMessageId: { type: Sequelize.STRING(128), allowNull: true },
      idempotencyKey: { type: Sequelize.STRING(191), allowNull: false },
      lastError: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      statusEvents: { type: Sequelize.JSON, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex(
      'whatsapp_message_logs',
      ['companyId', 'idempotencyKey'],
      { unique: true, name: 'whatsapp_message_logs_idempotency_uidx' },
    )
    await queryInterface.addIndex(
      'whatsapp_message_logs',
      ['companyId', 'providerMessageId'],
      { unique: true, name: 'whatsapp_message_logs_provider_uidx' },
    )
    await queryInterface.addIndex('whatsapp_message_logs', ['companyId', 'createdAt'], {
      name: 'whatsapp_message_logs_company_created_idx',
    })

    await queryInterface.createTable('whatsapp_outbox', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      messageLogId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'whatsapp_message_logs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      recipientPhone: { type: Sequelize.STRING(32), allowNull: false },
      recipientType: { type: Sequelize.STRING(32), allowNull: false },
      templateName: { type: Sequelize.STRING(120), allowNull: false },
      language: { type: Sequelize.STRING(16), allowNull: false },
      templateParameters: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      maxAttempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5 },
      nextAttemptAt: { type: Sequelize.DATE, allowNull: false },
      lockedAt: { type: Sequelize.DATE, allowNull: true },
      lockedBy: { type: Sequelize.STRING(128), allowNull: true },
      lockExpiresAt: { type: Sequelize.DATE, allowNull: true },
      lockToken: { type: Sequelize.CHAR(36), allowNull: true },
      idempotencyKey: { type: Sequelize.STRING(191), allowNull: false },
      lastError: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      providerMessageId: { type: Sequelize.STRING(128), allowNull: true },
      workflowKey: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex(
      'whatsapp_outbox',
      ['companyId', 'idempotencyKey'],
      { unique: true, name: 'whatsapp_outbox_idempotency_uidx' },
    )
    await queryInterface.addIndex(
      'whatsapp_outbox',
      ['status', 'nextAttemptAt', 'lockExpiresAt'],
      { name: 'whatsapp_outbox_lease_idx' },
    )

    await queryInterface.createTable('whatsapp_webhook_events', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      dedupeKey: { type: Sequelize.STRING(191), allowNull: false },
      providerMessageId: { type: Sequelize.STRING(128), allowNull: true },
      eventType: { type: Sequelize.STRING(64), allowNull: false },
      payloadDigest: { type: Sequelize.CHAR(64), allowNull: true },
      processedAt: { type: Sequelize.DATE, allowNull: true },
      outcome: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'received' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('whatsapp_webhook_events', ['dedupeKey'], {
      unique: true,
      name: 'whatsapp_webhook_events_dedupe_uidx',
    })
    await queryInterface.addIndex('whatsapp_webhook_events', ['companyId', 'createdAt'], {
      name: 'whatsapp_webhook_events_company_created_idx',
    })

    await queryInterface.createTable('whatsapp_audit_logs', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      actorUserId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      action: { type: Sequelize.STRING(64), allowNull: false },
      target: { type: Sequelize.STRING(191), allowNull: false },
      outcome: { type: Sequelize.STRING(32), allowNull: false },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      requestId: { type: Sequelize.STRING(64), allowNull: true },
      detail: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('whatsapp_audit_logs', ['companyId', 'createdAt'], {
      name: 'whatsapp_audit_logs_company_created_idx',
    })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('whatsapp_audit_logs')
    await queryInterface.dropTable('whatsapp_webhook_events')
    await queryInterface.dropTable('whatsapp_outbox')
    await queryInterface.dropTable('whatsapp_message_logs')
    await queryInterface.dropTable('whatsapp_workflow_bindings')
    await queryInterface.dropTable('whatsapp_templates')
    await queryInterface.dropTable('whatsapp_embedded_signup_sessions')
    await queryInterface.dropTable('whatsapp_company_configs')
  },
}
