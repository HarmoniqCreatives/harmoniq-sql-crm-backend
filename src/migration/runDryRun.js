'use strict'

/**
 * CLI dry-run against a JSON export file (fixtures or offline export).
 *
 * Usage:
 *   node src/migration/runDryRun.js [path/to/export.json]
 *
 * Does not connect to Mongo or MySQL.
 */

const fs = require('fs')
const path = require('path')
const { runDryRun } = require('./dryRun')

function main() {
  const inputPath = process.argv[2]
    || path.join(__dirname, 'fixtures', 'sampleExport.json')
  const absolute = path.resolve(inputPath)
  const raw = fs.readFileSync(absolute, 'utf8')
  const payload = JSON.parse(raw)
  const result = runDryRun(payload, { title: `Dry-run: ${path.basename(absolute)}` })

  process.stdout.write(result.reportMarkdown)
  process.stdout.write('\n')
  if (result.transformPreview) {
    process.stdout.write('## Transform preview (redacted)\n')
    process.stdout.write('```json\n')
    process.stdout.write(`${JSON.stringify(result.transformPreview, null, 2)}\n`)
    process.stdout.write('```\n')
  }
  if (result.transformError) {
    process.stdout.write(`Transform error: ${result.transformError}\n`)
  }

  process.exitCode = result.validation.ok ? 0 : 1
}

if (require.main === module) {
  main()
}

module.exports = { main }
