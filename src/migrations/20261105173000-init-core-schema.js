'use strict'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('companies', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      name: { type: Sequelize.STRING(160), allowNull: false },
      nameKey: { type: Sequelize.STRING(180), allowNull: false, unique: true },
      timezone: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'Asia/Kolkata' },
      baseCurrency: { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'INR' },
      enabledCurrencies: { type: Sequelize.JSON, allowNull: false },
      logoUrl: { type: Sequelize.STRING(500), allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })

    await queryInterface.createTable('roles', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      key: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      permissions: { type: Sequelize.JSON, allowNull: false },
      scope: {
        type: Sequelize.ENUM('OWN', 'TEAM', 'BRANCH', 'COMPANY'),
        allowNull: false,
        defaultValue: 'COMPANY',
      },
      isSystem: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      isProtected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('roles', ['companyId', 'key'], {
      unique: true,
      name: 'roles_company_id_key_unique',
    })

    await queryInterface.createTable('branches', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      nameKey: { type: Sequelize.STRING(140), allowNull: false },
      timezone: { type: Sequelize.STRING(64), allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('branches', ['companyId', 'nameKey'], {
      unique: true,
      name: 'branches_company_id_name_key_unique',
    })

    await queryInterface.createTable('users', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      branchId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      teamId: { type: Sequelize.CHAR(36), allowNull: true },
      roleId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'roles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      email: { type: Sequelize.STRING(190), allowNull: false },
      phone: { type: Sequelize.STRING(32), allowNull: true },
      passwordHash: { type: Sequelize.STRING(255), allowNull: false },
      status: {
        type: Sequelize.ENUM('PENDING', 'ACTIVE', 'DISABLED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      emailVerified: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      isInitialSuperAdmin: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      isPlatformOperator: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      emailVerifyTokenHash: { type: Sequelize.STRING(128), allowNull: true },
      emailVerifyExpiresAt: { type: Sequelize.DATE, allowNull: true },
      resetTokenHash: { type: Sequelize.STRING(128), allowNull: true },
      resetExpiresAt: { type: Sequelize.DATE, allowNull: true },
      lastLoginAt: { type: Sequelize.DATE, allowNull: true },
      disabledAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('users', ['companyId', 'email'], {
      unique: true,
      name: 'users_company_id_email_unique',
    })
    await queryInterface.addIndex('users', ['companyId', 'status'], {
      name: 'users_company_id_status_idx',
    })

    await queryInterface.createTable('teams', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      branchId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      nameKey: { type: Sequelize.STRING(140), allowNull: false },
      managerUserId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('teams', ['companyId', 'nameKey'], {
      unique: true,
      name: 'teams_company_id_name_key_unique',
    })

    await queryInterface.addConstraint('users', {
      fields: ['teamId'],
      type: 'foreign key',
      name: 'users_team_id_fkey',
      references: { table: 'teams', field: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    })

    await queryInterface.createTable('sessions', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
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
      tokenHash: { type: Sequelize.STRING(128), allowNull: false, unique: true },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('sessions', ['expiresAt'], { name: 'sessions_expires_at_idx' })

    await queryInterface.createTable('invitations', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      email: { type: Sequelize.STRING(190), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      roleId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'roles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
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
      tokenHash: { type: Sequelize.STRING(128), allowNull: true },
      claimId: { type: Sequelize.STRING(64), allowNull: true },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      invitedBy: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      status: {
        type: Sequelize.ENUM('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      acceptedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('invitations', ['companyId', 'email', 'status'], {
      name: 'invitations_company_email_status_idx',
    })

    await queryInterface.createTable('catalog_items', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      kind: {
        type: Sequelize.ENUM('STATUS', 'TAG', 'ACTIVITY'),
        allowNull: false,
      },
      key: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      tone: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'neutral' },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isSystem: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('catalog_items', ['companyId', 'kind', 'key'], {
      unique: true,
      name: 'catalog_items_company_kind_key_unique',
    })

    await queryInterface.createTable('counters', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      key: { type: Sequelize.STRING(64), allowNull: false },
      value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('counters', ['companyId', 'key'], {
      unique: true,
      name: 'counters_company_id_key_unique',
    })

    await queryInterface.createTable('subscriptions', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      companyId: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      planCode: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'free' },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'trialing' },
      seats: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5 },
      currentPeriodStart: { type: Sequelize.DATE, allowNull: true },
      currentPeriodEnd: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('subscriptions', ['companyId', 'status'], {
      name: 'subscriptions_company_id_status_idx',
    })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('subscriptions')
    await queryInterface.dropTable('counters')
    await queryInterface.dropTable('catalog_items')
    await queryInterface.dropTable('invitations')
    await queryInterface.dropTable('sessions')
    await queryInterface.removeConstraint('users', 'users_team_id_fkey').catch(() => {})
    await queryInterface.dropTable('teams')
    await queryInterface.dropTable('users')
    await queryInterface.dropTable('branches')
    await queryInterface.dropTable('roles')
    await queryInterface.dropTable('companies')
  },
}
