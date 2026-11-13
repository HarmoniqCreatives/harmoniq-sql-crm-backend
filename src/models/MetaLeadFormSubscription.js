const { DataTypes } = require('sequelize')
const { metaFormSubscriptionStatuses } = require('../utils/enums')

/**
 * Lead form subscriptions observed for a connected Page.
 * Phase 1 creates the table; form discovery/sync fills it in later phases.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineMetaLeadFormSubscription(sequelize) {
  return sequelize.define('MetaLeadFormSubscription', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    metaPageId: { type: DataTypes.CHAR(36), allowNull: false },
    connectionId: { type: DataTypes.CHAR(36), allowNull: false },
    pageId: { type: DataTypes.STRING(64), allowNull: false },
    formId: { type: DataTypes.STRING(64), allowNull: false },
    formName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    status: {
      type: DataTypes.ENUM(...Object.values(metaFormSubscriptionStatuses)),
      allowNull: false,
      defaultValue: metaFormSubscriptionStatuses.active,
    },
    lastSeenAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'meta_lead_form_subscriptions',
  })
}

module.exports = { defineMetaLeadFormSubscription }
