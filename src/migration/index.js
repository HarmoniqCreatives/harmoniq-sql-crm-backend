'use strict'

const { createIdMap } = require('./lib/idMap')
const { mapRolePermissions, listSqlPermissionKeys } = require('./lib/permissionMap')
const {
  mapCompanyActivation,
  mapUserStatus,
  mapEmailVerified,
  mapRoleScope,
} = require('./lib/statusMap')
const {
  isBcryptHashFormat,
  runPasswordCompatibilityTest,
  assertPasswordGate,
} = require('./lib/passwordGate')
const { validateExportPayload, transformExportToSqlRecords } = require('./lib/validators')
const { formatValidationReport } = require('./lib/report')
const { redactSecrets } = require('./lib/sanitize')
const {
  exportFromDocuments,
  exportFromMongoLive,
  exportFromCompassBackupDir,
  assertActiveUserCount,
} = require('./export/exportMongo')
const { prepareImportPlan, importToSqlLive } = require('./import/importSql')
const { reconcileAgainstDestination } = require('./lib/reconcile')
const { applyDestinationRemap } = require('./lib/remap')
const { runDryRun } = require('./dryRun')

module.exports = {
  createIdMap,
  mapRolePermissions,
  listSqlPermissionKeys,
  mapCompanyActivation,
  mapUserStatus,
  mapEmailVerified,
  mapRoleScope,
  isBcryptHashFormat,
  runPasswordCompatibilityTest,
  assertPasswordGate,
  validateExportPayload,
  transformExportToSqlRecords,
  formatValidationReport,
  redactSecrets,
  reconcileAgainstDestination,
  applyDestinationRemap,
  exportFromDocuments,
  exportFromMongoLive,
  exportFromCompassBackupDir,
  assertActiveUserCount,
  prepareImportPlan,
  importToSqlLive,
  runDryRun,
}
