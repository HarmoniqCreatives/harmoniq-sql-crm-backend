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
  lines.push(`- Branches: ${result.counts.branches || 0}`)
  lines.push(`- Teams: ${result.counts.teams || 0}`)
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

  if (options.reconciliation) {
    const r = options.reconciliation
    lines.push('## Destination reconciliation')
    lines.push('')
    const singular = {
      companies: 'company',
      branches: 'branch',
      teams: 'team',
      roles: 'role',
      users: 'user',
    }
    lines.push('| Entity | Source | Destination | Ready | Existing (skip) | Conflicts |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
    for (const entity of ['companies', 'branches', 'teams', 'roles', 'users']) {
      const conflictCount = (r.conflicts || []).filter((c) => c.entity === singular[entity]).length
      lines.push(
        `| ${entity} | ${r.sourceCounts?.[entity] ?? 0} | ${r.destinationCounts?.[entity] ?? 0} | ${r.readyToImport?.[entity] ?? 0} | ${r.existingMatches?.[entity] ?? 0} | ${conflictCount} |`,
      )
    }
    lines.push('')
    if ((r.conflicts || []).length === 0) {
      lines.push('Missing / conflict details: none')
    } else {
      lines.push('Conflicts / duplicate keys:')
      for (const c of r.conflicts) {
        lines.push(`- [${c.reason}] ${c.entity} ${c.id}${c.email ? ` (${c.email})` : ''}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

module.exports = { formatValidationReport }
