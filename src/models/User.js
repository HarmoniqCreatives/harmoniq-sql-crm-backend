const { DataTypes } = require('sequelize')
const { userStatuses } = require('../utils/enums')

/**
 * Company-scoped user account.
 *
 * Tenant ownership is enforced via `companyId`. Credentials are stored only as
 * `passwordHash`. Verify/reset tokens are stored as SHA-256 hashes with expiry.
 *
 * Relationships:
 * - belongsTo Company, Role, Branch?, Team?
 * - hasMany Session
 *
 * Constraints:
 * - unique (companyId, email)
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {import('sequelize').ModelStatic}
 */
function defineUser(sequelize) {
  return sequelize.define('User', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    branchId: { type: DataTypes.CHAR(36), allowNull: true },
    teamId: { type: DataTypes.CHAR(36), allowNull: true },
    roleId: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(190), allowNull: false },
    phone: { type: DataTypes.STRING(32), allowNull: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(userStatuses)),
      allowNull: false,
      defaultValue: userStatuses.pending,
    },
    emailVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** First Super Admin created at company registration; protected from demotion by others. */
    isInitialSuperAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isPlatformOperator: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    emailVerifyTokenHash: { type: DataTypes.STRING(128), allowNull: true },
    emailVerifyExpiresAt: { type: DataTypes.DATE, allowNull: true },
    resetTokenHash: { type: DataTypes.STRING(128), allowNull: true },
    resetExpiresAt: { type: DataTypes.DATE, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    disabledAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'users',
  })
}

module.exports = { defineUser }
