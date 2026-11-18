'use strict'

const { redactSecrets } = require('./sanitize')

/**
 * Build a human-readable validation report (no secrets).
 */
function formatValidationReport(result, options = {}) {
  const title = options.title || 'User Migration Dry-Run Report'
  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`Generated: ${options.generatedAt || new Date().toISOString()}`)
  lines.push(`Result: ${result.ok ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push('## Counts')
  lines.push(`- Companies: ${result.counts.companies}`)
  lines.push(`- Roles: ${result.counts.roles}`)
  lines.push(`- Users: ${result.counts.users}`)
  lines.push('')
  lines.push('### Roles per company')
  for (const [cid, count] of Object.entries(result.counts.rolesPerCompany || {})) {
    lines.push(`- ${cid}: ${count}`)
  }
  lines.push('')
  lines.push('### Users per company')
  for (const [cid, count] of Object.entries(result.counts.usersPerCompany || {})) {
    lines.push(`- ${cid}: ${count}`)
  }
  lines.push('')
  lines.push('## Password compatibility gate')
  lines.push(`- Passed: ${result.passwordGate.passed}`)
  lines.push(`- Tested at: ${result.passwordGate.testedAt || 'n/a'}`)
  lines.push('')
  lines.push(`## Errors (${result.errors.length})`)
  if (result.errors.length === 0) {
    lines.push('- None')
  } else {
    for (const err of result.errors) {
      lines.push(`- [${err.code}] ${err.message}`)
    }
  }
  lines.push('')
  lines.push(`## Warnings (${result.warnings.length})`)
  if (result.warnings.length === 0) {
    lines.push('- None')
  } else {
    for (const warn of result.warnings) {
      lines.push(`- [${warn.code}] ${warn.message}`)
    }
  }
  lines.push('')
  lines.push('## Redacted error details (JSON)')
  lines.push('```json')
  lines.push(JSON.stringify(redactSecrets(result.errors), null, 2))
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

module.exports = { formatValidationReport }
