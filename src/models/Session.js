const { DataTypes } = require('sequelize')

/**
 * Refresh-token session row for a user within a company.
 *
 * Plain refresh tokens are never stored—only `tokenHash`. Rotation stores
 * `replacedBySessionId` and sets `revokedAt`. Reuse of a revoked token
 * invalidates the whole `familyId` chain (theft detection).
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {import('sequelize').ModelStatic}
 */
function defineSession(sequelize) {
  return sequelize.define('Session', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    userId: { type: DataTypes.CHAR(36), allowNull: false },
    tokenHash: { type: DataTypes.STRING(128), allowNull: false, unique: true },
    familyId: { type: DataTypes.CHAR(36), allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    replacedBySessionId: { type: DataTypes.CHAR(36), allowNull: true },
    userAgent: { type: DataTypes.STRING(255), allowNull: true },
    ipAddress: { type: DataTypes.STRING(64), allowNull: true },
  }, {
    tableName: 'sessions',
  })
}

module.exports = { defineSession }
