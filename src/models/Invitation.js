const { DataTypes } = require('sequelize')
const { emailDeliveryStatuses, invitationStatuses } = require('../utils/enums')

/**
 * Pending membership invite for a company email.
 *
 * Security rules:
 * - Store only SHA-256 `tokenHash` (never the raw token).
 * - Unique `tokenHash` enables single-use lookup; cleared on accept/revoke.
 * - `emailDelivery` / `emailError` track background mail without secrets.
 *
 * Tenant: always scoped by `companyId`. Cross-company access returns 404.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {import('sequelize').ModelStatic}
 */
function defineInvitation(sequelize) {
  return sequelize.define('Invitation', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    email: { type: DataTypes.STRING(190), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    roleId: { type: DataTypes.CHAR(36), allowNull: false },
    branchId: { type: DataTypes.CHAR(36), allowNull: true },
    teamId: { type: DataTypes.CHAR(36), allowNull: true },
    tokenHash: { type: DataTypes.STRING(128), allowNull: true, unique: true },
    claimId: { type: DataTypes.STRING(64), allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    invitedBy: { type: DataTypes.CHAR(36), allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(invitationStatuses)),
      allowNull: false,
      defaultValue: invitationStatuses.pending,
    },
    emailDelivery: {
      type: DataTypes.ENUM(...Object.values(emailDeliveryStatuses)),
      allowNull: true,
    },
    emailError: { type: DataTypes.STRING(80), allowNull: true },
    acceptedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'invitations',
  })
}

module.exports = { defineInvitation }
