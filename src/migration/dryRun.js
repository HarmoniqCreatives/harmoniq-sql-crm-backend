'use strict'

const { validateExportPayload, transformExportToSqlRecords } = require('./lib/validators')
const { createIdMap } = require('./lib/idMap')
const { formatValidationReport } = require('./lib/report')
const { redactSecrets } = require('./lib/sanitize')

/**
 * Full dry-run: validate + transform preview (no DB writes).
 */
function runDryRun(exportPayload, options = {}) {
  const validation = validateExportPayload(exportPayload)
  const idMap = createIdMap(options.idMapEntries || [])

  let transformPreview = null
  let transformError = null
  if (validation.ok || options.transformEvenIfInvalid) {
    try {
      const records = transformExportToSqlRecords(exportPayload, idMap, {
        companyForceStatuses: options.companyForceStatuses || {},
      })
      transformPreview = {
        companies: records.companies.length,
        roles: records.roles.length,
        users: records.users.length,
        sampleCompany: redactSecrets(records.companies[0] || null),
        sampleRole: redactSecrets(records.roles[0] || null),
        sampleUser: records.users[0]
          ? redactSecrets({ ...records.users[0], passwordHash: '[REDACTED]' })
          : null,
        superAdminPermissionsCount: (
          records.roles.find((r) => r.isProtected || r.key === 'super_admin') || { permissions: [] }
        ).permissions.length,
      }
    } catch (error) {
      transformError = error.message
    }
  }

  const reportMarkdown = formatValidationReport(validation, {
    title: options.title || 'User Migration Dry-Run Report',
    generatedAt: new Date().toISOString(),
  })

  return {
    validation,
    transformPreview,
    transformError,
    idMapEntries: idMap.toJSON(),
    reportMarkdown,
  }
}

module.exports = { runDryRun }
