const { DataTypes } = require('sequelize')
const { leadPurposes, leadSources, propertyTypes, readinessValues } = require('../utils/enums')

/**
 * Tenant-scoped lead. Soft-deleted via `deletedAt` (paranoid).
 * Numbers are never reused after soft delete.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineLead(sequelize) {
  return sequelize.define('Lead', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    number: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    phone: { type: DataTypes.STRING(32), allowNull: false },
    email: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    source: { type: DataTypes.ENUM(...Object.values(leadSources)), allowNull: false, defaultValue: leadSources.manual },
    metaLeadId: { type: DataTypes.STRING(128), allowNull: true },
    campaignId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    campaignName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    statusId: { type: DataTypes.CHAR(36), allowNull: false },
    primaryAgentId: { type: DataTypes.CHAR(36), allowNull: true },
    secondaryAgentId: { type: DataTypes.CHAR(36), allowNull: true },
    branchId: { type: DataTypes.CHAR(36), allowNull: true },
    teamId: { type: DataTypes.CHAR(36), allowNull: true },
    propertyType: { type: DataTypes.ENUM(...Object.values(propertyTypes)), allowNull: false, defaultValue: propertyTypes.apartment },
    purpose: { type: DataTypes.ENUM(...Object.values(leadPurposes)), allowNull: false, defaultValue: leadPurposes.buy },
    location: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
    budget: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
    currency: { type: DataTypes.STRING(8), allowNull: false },
    builtUpArea: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
    carpetArea: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
    readiness: { type: DataTypes.ENUM(...Object.values(readinessValues)), allowNull: false, defaultValue: readinessValues.readyToMove },
    nextFollowUpAt: { type: DataTypes.DATE, allowNull: true },
    deletedBy: { type: DataTypes.CHAR(36), allowNull: true },
  }, {
    tableName: 'leads',
    paranoid: true,
    deletedAt: 'deletedAt',
  })
}

module.exports = { defineLead }
