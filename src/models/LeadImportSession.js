'use strict'

const { DataTypes } = require('sequelize')

/**
 * Company-scoped Excel import session. Parsed rows and decisions live in JSON
 * so one session can hold up to the configured row limit without N child tables.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineLeadImportSession(sequelize) {
  return sequelize.define('LeadImportSession', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    userId: { type: DataTypes.CHAR(36), allowNull: false },
    originalFilename: { type: DataTypes.STRING(255), allowNull: false },
    fileSizeBytes: { type: DataTypes.INTEGER, allowNull: false },
    mimeType: { type: DataTypes.STRING(128), allowNull: true },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'uploaded' },
    rowCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    headersJson: { type: DataTypes.JSON, allowNull: true },
    mappingJson: { type: DataTypes.JSON, allowNull: true },
    rowsJson: { type: DataTypes.JSON, allowNull: true },
    validationSummaryJson: { type: DataTypes.JSON, allowNull: true },
    decisionsJson: { type: DataTypes.JSON, allowNull: true },
    resultsJson: { type: DataTypes.JSON, allowNull: true },
    errorMessage: { type: DataTypes.STRING(500), allowNull: true },
    idempotencyKey: { type: DataTypes.STRING(191), allowNull: true },
    confirmToken: { type: DataTypes.STRING(64), allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'lead_import_sessions',
  })
}

module.exports = { defineLeadImportSession }
