const { DataTypes } = require('sequelize')
const { metaWebhookIngestionStatuses } = require('../utils/enums')

/**
 * Durable webhook leadgen events. Phase 1 stores status `received` only — no Graph/lead create.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineMetaWebhookIngestion(sequelize) {
  return sequelize.define('MetaWebhookIngestion', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    // Null when status is ignored (unknown Page — no company association).
    companyId: { type: DataTypes.CHAR(36), allowNull: true },
    metaPageId: { type: DataTypes.CHAR(36), allowNull: true },
    connectionId: { type: DataTypes.CHAR(36), allowNull: true },
    pageId: { type: DataTypes.STRING(64), allowNull: false },
    leadgenId: { type: DataTypes.STRING(64), allowNull: false },
    formId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    dedupeKey: { type: DataTypes.STRING(191), allowNull: false, unique: true },
    status: {
      type: DataTypes.ENUM(...Object.values(metaWebhookIngestionStatuses)),
      allowNull: false,
      defaultValue: metaWebhookIngestionStatuses.received,
    },
    leadId: { type: DataTypes.CHAR(36), allowNull: true },
    retryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: true },
    formName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    pageName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    campaignId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    campaignName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    adSetId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    adSetName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    adId: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    adName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    facebookCreatedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'meta_webhook_ingestions',
  })
}

module.exports = { defineMetaWebhookIngestion }
