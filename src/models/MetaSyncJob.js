const { DataTypes } = require('sequelize')
const { metaSyncJobStatuses } = require('../utils/enums')

/**
 * Manual / future auto pull job for one connected Facebook Page.
 * Claimed with DB status transition so multiple API instances cannot run the same job.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineMetaSyncJob(sequelize) {
  return sequelize.define('MetaSyncJob', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    metaPageId: { type: DataTypes.CHAR(36), allowNull: false },
    facebookPageId: { type: DataTypes.STRING(64), allowNull: false },
    createdByUserId: { type: DataTypes.CHAR(36), allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(metaSyncJobStatuses)),
      allowNull: false,
      defaultValue: metaSyncJobStatuses.pending,
    },
    since: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    formId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    imported: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    skipped: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    pending: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    formsTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    formsDone: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    leadsSeen: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    errorMessage: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    leaseOwner: { type: DataTypes.STRING(64), allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'meta_sync_jobs',
  })
}

module.exports = { defineMetaSyncJob }
