const { DataTypes } = require('sequelize')
const {
  leadEntryMethods,
  leadPurposes,
  leadSources,
  propertyTypes,
  readinessValues,
} = require('../utils/enums')

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
    alternatePhone: { type: DataTypes.STRING(32), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    source: { type: DataTypes.ENUM(...Object.values(leadSources)), allowNull: false, defaultValue: leadSources.manual },
    subSource: { type: DataTypes.STRING(120), allowNull: true },
    agencyName: { type: DataTypes.STRING(200), allowNull: true },
    statusReason: { type: DataTypes.STRING(300), allowNull: true },
    receivedOn: { type: DataTypes.DATE, allowNull: true },
    entryMethod: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: leadEntryMethods.manual,
    },
    importSessionId: { type: DataTypes.CHAR(36), allowNull: true },
    /** CRM import/sync time for Meta/Excel origins only; null for manual/unknown. Immutable after create. */
    importedAt: { type: DataTypes.DATE, allowNull: true },
    metaLeadId: { type: DataTypes.STRING(128), allowNull: true },
    /** Original Meta/Facebook lead generation time (`created_time`). Null for manual leads. */
    metaCreatedAt: { type: DataTypes.DATE, allowNull: true },
    campaignId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    campaignName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    /** Graph campaign `effective_status` (e.g. ACTIVE, PAUSED). Empty when unknown. */
    campaignStatus: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '' },
    adId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    adName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    adSetId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    adSetName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    formId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    formName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    facebookPageId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    facebookPageName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    /** pending|completed|partial|failed|not_applicable — Meta advertising metadata only. */
    metaEnrichmentStatus: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'not_applicable',
    },
    /** Short enrichment failure category (no secrets / PII). */
    metaEnrichmentError: { type: DataTypes.STRING(80), allowNull: false, defaultValue: '' },
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
