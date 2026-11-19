'use strict'

const { validateExportPayload, transformExportToSqlRecords } = require('./lib/validators')
const { createIdMap } = require('./lib/idMap')
const { formatValidationReport } = require('./lib/report')
const { redactSecrets } = require('./lib/sanitize')
const { reconcileAgainstDestination } = require('./lib/reconcile')

/**
 * Full dry-run: validate + transform preview + optional destination reconcile (no DB writes).
 */
function runDryRun(exportPayload, options = {}) {
  const validation = validateExportPayload(exportPayload)
  const idMap = createIdMap(options.idMapEntries || [])

  let transformPreview = null
  let transformError = null
  let records = null
  let reconciliation = null

  if (validation.ok || options.transformEvenIfInvalid) {
    try {
      records = transformExportToSqlRecords(exportPayload, idMap, {
        companyForceStatuses: options.companyForceStatuses || {},
      })
      reconciliation = reconcileAgainstDestination(records, options.destinationSnapshot || null)
      transformPreview = {
        companies: records.companies.length,
        branches: records.branches.length,
        teams: records.teams.length,
        roles: records.roles.length,
        users: records.users.length,
        sampleCompany: redactSecrets(records.companies[0] || null),
        sampleBranch: redactSecrets(records.branches[0] || null),
        sampleTeam: redactSecrets(records.teams[0] || null),
        sampleRole: redactSecrets(records.roles[0] || null),
        sampleUser: records.users[0]
          ? redactSecrets({ ...records.users[0], passwordHash: '[REDACTED]' })
          : null,
        superAdminPermissionsCount: (
          records.roles.find((r) => r.isProtected || r.key === 'super_admin') || { permissions: [] }
        ).permissions.length,
        reconciliation,
      }
    } catch (error) {
      transformError = error.message
    }
  }

  const reportMarkdown = formatValidationReport(validation, {
    title: options.title || 'Company / Role / User Migration Dry-Run Report',
    generatedAt: new Date().toISOString(),
    reconciliation,
  })

  return {
    validation,
    transformPreview,
    transformError,
    reconciliation,
    idMapEntries: idMap.toJSON(),
    reportMarkdown,
  }
}

module.exports = { runDryRun }
