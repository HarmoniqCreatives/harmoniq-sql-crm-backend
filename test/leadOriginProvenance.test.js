'use strict'

/**
 * Lead origin / provenance unit tests (no MySQL required).
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { leadEntryMethods } = require('../src/utils/enums')
const {
  resolveCreateProvenance,
  normalizeEntryMethodFilter,
} = require('../src/services/leadService')

test('leadEntryMethods includes unknown and keeps api_import', () => {
  assert.equal(leadEntryMethods.manual, 'manual')
  assert.equal(leadEntryMethods.excelImport, 'excel_import')
  assert.equal(leadEntryMethods.metaImport, 'meta_import')
  assert.equal(leadEntryMethods.apiImport, 'api_import')
  assert.equal(leadEntryMethods.unknown, 'unknown')
})

test('resolveCreateProvenance: manual has null importedAt', () => {
  const result = resolveCreateProvenance({})
  assert.equal(result.entryMethod, 'manual')
  assert.equal(result.importSessionId, null)
  assert.equal(result.importedAt, null)
})

test('resolveCreateProvenance: metaImport forces meta_import and importedAt', () => {
  const result = resolveCreateProvenance({ metaImport: true })
  assert.equal(result.entryMethod, 'meta_import')
  assert.ok(result.importedAt instanceof Date)
})

test('resolveCreateProvenance: excel sets session and importedAt', () => {
  const when = new Date('2026-11-26T10:00:00.000Z')
  const result = resolveCreateProvenance({
    entryMethod: leadEntryMethods.excelImport,
    importSessionId: 'session-1',
    importedAt: when,
  })
  assert.equal(result.entryMethod, 'excel_import')
  assert.equal(result.importSessionId, 'session-1')
  assert.equal(result.importedAt.toISOString(), when.toISOString())
})

test('resolveCreateProvenance ignores invalid entryMethod values', () => {
  const result = resolveCreateProvenance({ entryMethod: 'hacked' })
  assert.equal(result.entryMethod, 'manual')
  assert.equal(result.importedAt, null)
})

test('normalizeEntryMethodFilter accepts aliases', () => {
  assert.equal(normalizeEntryMethodFilter('META'), 'meta_import')
  assert.equal(normalizeEntryMethodFilter('Excel Import'), 'excel_import')
  assert.equal(normalizeEntryMethodFilter('unknown'), 'unknown')
  assert.equal(normalizeEntryMethodFilter('nope'), null)
})
