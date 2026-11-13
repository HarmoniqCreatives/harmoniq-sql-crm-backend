'use strict'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('companies', 'status', {
      type: Sequelize.ENUM('PENDING_VERIFICATION', 'ACTIVE', 'DISABLED'),
      allowNull: false,
      defaultValue: 'PENDING_VERIFICATION',
      after: 'isActive',
    })
    await queryInterface.addIndex('companies', ['status'], { name: 'companies_status_idx' })

    await queryInterface.addColumn('sessions', 'familyId', {
      type: Sequelize.CHAR(36),
      allowNull: true,
      after: 'tokenHash',
    })
    await queryInterface.addColumn('sessions', 'revokedAt', {
      type: Sequelize.DATE,
      allowNull: true,
      after: 'expiresAt',
    })
    await queryInterface.addColumn('sessions', 'replacedBySessionId', {
      type: Sequelize.CHAR(36),
      allowNull: true,
      after: 'revokedAt',
    })
    await queryInterface.addColumn('sessions', 'userAgent', {
      type: Sequelize.STRING(255),
      allowNull: true,
      after: 'replacedBySessionId',
    })
    await queryInterface.addColumn('sessions', 'ipAddress', {
      type: Sequelize.STRING(64),
      allowNull: true,
      after: 'userAgent',
    })
    await queryInterface.addIndex('sessions', ['userId', 'revokedAt'], {
      name: 'sessions_user_id_revoked_at_idx',
    })
    await queryInterface.addIndex('sessions', ['familyId'], {
      name: 'sessions_family_id_idx',
    })
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('sessions', 'sessions_family_id_idx').catch(() => {})
    await queryInterface.removeIndex('sessions', 'sessions_user_id_revoked_at_idx').catch(() => {})
    await queryInterface.removeColumn('sessions', 'ipAddress')
    await queryInterface.removeColumn('sessions', 'userAgent')
    await queryInterface.removeColumn('sessions', 'replacedBySessionId')
    await queryInterface.removeColumn('sessions', 'revokedAt')
    await queryInterface.removeColumn('sessions', 'familyId')
    await queryInterface.removeIndex('companies', 'companies_status_idx').catch(() => {})
    await queryInterface.removeColumn('companies', 'status')
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS enum_companies_status').catch(() => {})
  },
}
