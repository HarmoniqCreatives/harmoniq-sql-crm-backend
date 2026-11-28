'use strict'

/**
 * Lead Excel import — unit tests (no MySQL required).
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const ExcelJS = require('exceljs')

const {
  suggestMapping,
  parseWorkbookBuffer,
  buildImportTemplateBuffer,
} = require('../src/services/leadImportParseService')
const {
  parseImportDate,
  resolveSource,
  resolvePhone,
} = require('../src/services/leadImportResolveService')
const {
  applyDuplicateReviewFlags,
  buildInternalExcelDuplicateGroups,
  assertConfirmDecisions,
} = require('../src/services/leadImportService')
const { leadEntryMethods, leadImportDecisions, permissionKeys } = require('../src/utils/enums')
const assignmentNotifications = require('../src/services/assignmentNotificationService')
const leadService = require('../src/services/leadService')

test('permission and entry method enums', () => {
  assert.equal(permissionKeys.leadsImport, 'leads.import')
  assert.equal(leadEntryMethods.excelImport, 'excel_import')
  assert.equal(leadEntryMethods.metaImport, 'meta_import')
  assert.equal(leadImportDecisions.updateExisting, 'update_existing')
})

test('header synonym mapping', () => {
  const mapping = suggestMapping([
    'Name',
    'Contact No',
    'Assigned Agent',
    'Status',
    'Notes 1',
    'Unknown Column',
  ])
  assert.equal(mapping.Name, 'name')
  assert.equal(mapping['Contact No'], 'phone')
  assert.equal(mapping['Assigned Agent'], 'assignedAgent')
  assert.equal(mapping.Status, 'status')
  assert.equal(mapping['Notes 1'], 'note1')
  assert.equal(mapping['Unknown Column'], null)
})

test('phone resolution preserves E.164 and normalizes local with company dial', () => {
  assert.equal(resolvePhone('+971501234567', { required: true }).ok, true)
  assert.equal(resolvePhone('+971501234567', { required: true }).value, '+971501234567')
  assert.equal(resolvePhone('', { required: false }).ok, true)

  // Already includes known country digits without +
  assert.equal(resolvePhone('971501234567', { required: true, companyContext: { baseCurrency: 'USD' } }).ok, true)
  assert.equal(resolvePhone('971501234567', { required: true, companyContext: { baseCurrency: 'USD' } }).value, '+971501234567')

  // India / UAE / Pakistan local forms via company timezone or currency
  assert.equal(resolvePhone('9876543210', { required: true, companyContext: { timezone: 'Asia/Kolkata' } }).value, '+919876543210')
  assert.equal(resolvePhone('0501234567', { required: true, companyContext: { timezone: 'Asia/Dubai' } }).value, '+971501234567')
  assert.equal(resolvePhone('03001234567', { required: true, companyContext: { baseCurrency: 'PKR' } }).value, '+923001234567')

  // No company dial → keep Invalid (do not guess)
  const ambiguous = resolvePhone('9876543210', { required: true, companyContext: { baseCurrency: 'USD' } })
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error, /country code|dial code/i)

  // Too short national → Invalid
  assert.equal(resolvePhone('12345', { required: true, companyContext: { timezone: 'Asia/Dubai' } }).ok, false)
})

test('source and date parsing', () => {
  assert.equal(resolveSource('Facebook').value, 'facebook')
  assert.equal(resolveSource('').value, 'manual')
  assert.equal(resolveSource('unknown').ok, false)

  const dmy = parseImportDate('25-11-2026 10:30:00')
  assert.equal(dmy.ok, true)
  assert.equal(dmy.date.getFullYear(), 2026)
  assert.equal(dmy.date.getMonth(), 10)
  assert.equal(dmy.date.getDate(), 25)

  const ampm = parseImportDate('25-11-2026 10:30:00 PM')
  assert.equal(ampm.ok, true)
  assert.equal(ampm.date.getHours(), 22)

  assert.equal(parseImportDate('not-a-date').ok, false)
})

test('template workbook builds and parses', async () => {
  const buffer = await buildImportTemplateBuffer()
  assert.ok(Buffer.isBuffer(buffer))
  assert.ok(buffer.length > 100)
  assert.equal(buffer[0], 0x50)
  assert.equal(buffer[1], 0x4b)

  const parsed = await parseWorkbookBuffer(buffer, {
    originalFilename: 'melo-lead-import-template.xlsx',
    fileSizeBytes: buffer.length,
  })
  assert.ok(parsed.headers.includes('Name'))
  assert.ok(parsed.headers.includes('Contact No'))
  assert.ok(parsed.headers.includes('Lead note 10 (history)'))
  assert.ok(parsed.headers.includes('Lead note 1 Added On'))
  assert.ok(parsed.headers.includes('Lead note 1 Added By'))
  assert.ok(parsed.headers.includes('Lead note 10 Added On'))
  assert.ok(parsed.headers.includes('Lead note 10 Added By'))
  assert.equal(parsed.headers.filter((h) => String(h).startsWith('Lead note')).length, 30)
  assert.ok(parsed.rowCount >= 1)
})

test('explainSuggestedMapping never invents unrelated fields', () => {
  const { explainSuggestedMapping } = require('../src/services/leadImportParseService')
  const headers = ['Customer Name', 'Mystery Column', 'Note 3']
  const mapping = suggestMapping(headers)
  assert.equal(mapping['Customer Name'], 'name')
  assert.equal(mapping['Mystery Column'], null)
  assert.equal(mapping['Note 3'], 'note3')
  const reasons = explainSuggestedMapping(headers, mapping)
  assert.match(reasons['Customer Name'], /known labels|Exact match/i)
  assert.match(reasons['Mystery Column'], /No matching CRM field/i)
  assert.match(reasons['Note 3'], /Lead note 3/i)
})

test('rejects non-xlsx content', async () => {
  await assert.rejects(
    () => parseWorkbookBuffer(Buffer.from('not-an-excel'), {
      originalFilename: 'x.xlsx',
      fileSizeBytes: 11,
    }),
    (error) => Number(error.statusCode || error.status) === 400,
  )
})

test('rejects oversize declared file', async () => {
  const tiny = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  await assert.rejects(
    () => parseWorkbookBuffer(tiny, {
      originalFilename: 'big.xlsx',
      fileSizeBytes: 11 * 1024 * 1024,
    }),
    (error) => /10 MB/i.test(error.message),
  )
})

test('row limit enforced', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  sheet.addRow(['Name', 'Contact No', 'Status'])
  for (let i = 0; i < 5001; i += 1) {
    sheet.addRow([`Person ${i}`, `+9715${String(i).padStart(8, '0')}`, 'New'])
  }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  await assert.rejects(
    () => parseWorkbookBuffer(buffer, {
      originalFilename: 'many.xlsx',
      fileSizeBytes: buffer.length,
    }),
    (error) => /5,000/i.test(error.message),
  )
})

function sampleRow(excelRowNumber, phone, extras = {}) {
  return {
    excelRowNumber,
    phone,
    errors: [],
    warnings: [],
    duplicate: null,
    ...extras,
  }
}

test('internal Excel duplicates require manual review (not hard reject)', () => {
  const rows = [
    sampleRow(2, '+971501111111'),
    sampleRow(3, '+971501111111'),
    sampleRow(4, '+971502222222'),
  ]
  const phoneOwners = new Map([
    ['+971501111111', [2, 3]],
    ['+971502222222', [4]],
  ])
  applyDuplicateReviewFlags(rows, phoneOwners, [])

  assert.equal(rows[0].duplicate.requiresDecision, true)
  assert.equal(rows[0].duplicate.type, 'excel_internal')
  assert.deepEqual(rows[0].duplicate.excelGroup, [2, 3])
  assert.deepEqual(rows[0].duplicate.actions, [
    leadImportDecisions.skip,
    leadImportDecisions.importAsNew,
  ])
  assert.equal(rows[0].errors.length, 0)
  assert.equal(rows[1].duplicate.requiresDecision, true)
  assert.equal(rows[2].duplicate, null)

  const groups = buildInternalExcelDuplicateGroups(phoneOwners)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].excelRows, [2, 3])
})

test('CRM + Excel internal duplicates offer Update Existing and require lead selection when multiple', () => {
  const rows = [
    sampleRow(2, '+971503333333'),
    sampleRow(3, '+971503333333'),
  ]
  const phoneOwners = new Map([['+971503333333', [2, 3]]])
  const crmLeads = [
    {
      id: 'lead-a',
      number: 1001,
      name: 'Existing A',
      phone: '+971503333333',
      email: '',
      statusId: 'st-1',
      primaryAgentId: null,
    },
    {
      id: 'lead-b',
      number: 1002,
      name: 'Existing B',
      phone: '+971503333333',
      email: '',
      statusId: 'st-1',
      primaryAgentId: null,
    },
  ]
  applyDuplicateReviewFlags(rows, phoneOwners, crmLeads)
  assert.equal(rows[0].duplicate.type, 'crm_and_excel_internal')
  assert.equal(rows[0].duplicate.requiresLeadSelection, true)
  assert.ok(rows[0].duplicate.actions.includes(leadImportDecisions.updateExisting))
  assert.equal(rows[0].duplicate.matches.length, 2)
})

test('assertConfirmDecisions requires decisions for excel_internal and Import as New confirm', () => {
  const rows = [
    {
      excelRowNumber: 2,
      errors: [],
      duplicate: {
        requiresDecision: true,
        type: 'excel_internal',
        matches: [],
        actions: [leadImportDecisions.skip, leadImportDecisions.importAsNew],
      },
    },
    {
      excelRowNumber: 3,
      errors: [],
      duplicate: {
        requiresDecision: true,
        type: 'excel_internal',
        matches: [],
        actions: [leadImportDecisions.skip, leadImportDecisions.importAsNew],
      },
    },
  ]

  assert.throws(
    () => assertConfirmDecisions(rows, []),
    (error) => /duplicate row|decision/i.test(error.message),
  )

  assert.throws(
    () => assertConfirmDecisions(rows, [
      { excelRowNumber: 2, action: leadImportDecisions.importAsNew },
      { excelRowNumber: 3, action: leadImportDecisions.skip },
    ]),
    (error) => /confirm Import as New/i.test(error.message),
  )

  assert.throws(
    () => assertConfirmDecisions(rows, [
      { excelRowNumber: 2, action: leadImportDecisions.updateExisting, existingLeadId: 'x' },
      { excelRowNumber: 3, action: leadImportDecisions.skip },
    ]),
    (error) => /decision/i.test(error.message) || /Update Existing/i.test(error.message),
  )

  const map = assertConfirmDecisions(rows, [
    { excelRowNumber: 2, action: leadImportDecisions.importAsNew, confirmImportAsNew: true },
    { excelRowNumber: 3, action: leadImportDecisions.skip },
  ])
  assert.equal(map.get(2).action, leadImportDecisions.importAsNew)
  assert.equal(map.get(3).action, leadImportDecisions.skip)
})

test('assertConfirmDecisions rejects unresolved rows after partial bulk-style decisions', () => {
  const rows = [
    {
      excelRowNumber: 2,
      errors: [],
      duplicate: {
        requiresDecision: true,
        matches: [{ id: 'a' }],
        actions: [
          leadImportDecisions.skip,
          leadImportDecisions.updateExisting,
          leadImportDecisions.importAsNew,
        ],
      },
    },
    {
      excelRowNumber: 3,
      errors: [],
      duplicate: {
        requiresDecision: true,
        matches: [{ id: 'b' }, { id: 'c' }],
        actions: [
          leadImportDecisions.skip,
          leadImportDecisions.updateExisting,
          leadImportDecisions.importAsNew,
        ],
      },
    },
  ]
  // Skip All style payload missing row 3 → backend still rejects
  assert.throws(
    () => assertConfirmDecisions(rows, [
      { excelRowNumber: 2, action: leadImportDecisions.skip },
    ]),
    (error) => /duplicate row|decision/i.test(error.message),
  )
  // Update without selecting among multiple matches → reject
  assert.throws(
    () => assertConfirmDecisions(rows, [
      { excelRowNumber: 2, action: leadImportDecisions.skip },
      { excelRowNumber: 3, action: leadImportDecisions.updateExisting },
    ]),
    (error) => /select an active matching CRM lead/i.test(error.message),
  )
})

test('assertConfirmDecisions requires explicit CRM lead selection for multiple matches', () => {
  const rows = [{
    excelRowNumber: 5,
    errors: [],
    duplicate: {
      requiresDecision: true,
      type: 'crm_multiple',
      matches: [{ id: 'a' }, { id: 'b' }],
      actions: [
        leadImportDecisions.skip,
        leadImportDecisions.updateExisting,
        leadImportDecisions.importAsNew,
      ],
    },
  }]
  assert.throws(
    () => assertConfirmDecisions(rows, [{
      excelRowNumber: 5,
      action: leadImportDecisions.updateExisting,
      existingLeadId: 'not-in-list',
    }]),
    (error) => /select an active matching CRM lead/i.test(error.message),
  )
  const ok = assertConfirmDecisions(rows, [{
    excelRowNumber: 5,
    action: leadImportDecisions.updateExisting,
    existingLeadId: 'b',
  }])
  assert.equal(ok.get(5).existingLeadId, 'b')
})

test('multi-sheet parse respects sheetIndex and headerRow', async () => {
  const workbook = new ExcelJS.Workbook()
  const junk = workbook.addWorksheet('Cover')
  junk.addRow(['Ignore'])
  junk.addRow(['Not headers'])
  const data = workbook.addWorksheet('Leads')
  data.addRow(['meta'])
  data.addRow(['Name', 'Contact No', 'Status', 'Lead Source'])
  data.addRow(['Ada', '+971501234567', 'New', 'Direct'])
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())

  const wrong = await parseWorkbookBuffer(buffer, {
    originalFilename: 'multi.xlsx',
    fileSizeBytes: buffer.length,
    sheetIndex: 0,
    headerRow: 1,
  })
  assert.equal(wrong.sheetIndex, 0)
  assert.ok(wrong.sheets.length === 2)

  const parsed = await parseWorkbookBuffer(buffer, {
    originalFilename: 'multi.xlsx',
    fileSizeBytes: buffer.length,
    sheetIndex: 1,
    headerRow: 2,
  })
  assert.equal(parsed.sheetIndex, 1)
  assert.equal(parsed.headerRow, 2)
  assert.deepEqual(parsed.headers.slice(0, 4), ['Name', 'Contact No', 'Status', 'Lead Source'])
  assert.equal(parsed.rowCount, 1)
  assert.equal(parsed.rows[0].values.Name, 'Ada')
  assert.equal(parsed.suggestedMapping.Name, 'name')
  assert.equal(parsed.suggestedMapping['Lead Source'], 'source')
})

test('value mapping: exact source match auto-resolves; Direct and QRCode need review', () => {
  const {
    applySingleValueMap,
    suggestCatalogMatch,
    normalizeValueMappings,
    headerFingerprint,
  } = require('../src/services/leadImportValueMapService')
  const maps = { statusByName: new Map(), userByName: new Map(), tagByName: new Map() }

  assert.equal(suggestCatalogMatch('Facebook', 'source', maps).matched, true)
  assert.equal(suggestCatalogMatch('Direct', 'source', maps).matched, false)
  assert.equal(suggestCatalogMatch('QRCode', 'source', maps).matched, false)

  const auto = applySingleValueMap('source', 'instagram', normalizeValueMappings({}), maps)
  assert.equal(auto.ok, true)
  assert.equal(auto.value, 'instagram')
  assert.equal(auto.needReview, false)

  const need = applySingleValueMap('source', 'Direct', normalizeValueMappings({}), maps)
  assert.equal(need.needReview, true)
  assert.equal(need.value, null)

  const mapped = applySingleValueMap(
    'source',
    'Direct',
    normalizeValueMappings({ source: { Direct: 'manual' } }),
    maps,
  )
  assert.equal(mapped.needReview, false)
  assert.equal(mapped.value, 'manual')

  const empty = applySingleValueMap('source', '', normalizeValueMappings({}), maps)
  assert.equal(empty.value, 'manual')

  assert.equal(headerFingerprint(['Name', ' Contact No ']), 'name|contact no')
})

test('value mapping: status/agent/tags exact only; never invent catalogs', () => {
  const {
    applySingleValueMap,
    applyTagValueMaps,
    buildValueMappingWorkspace,
  } = require('../src/services/leadImportValueMapService')

  const statusByName = new Map([
    ['new', [{ id: 'st-new', name: 'New', key: 'new' }]],
    ['dropped', [{ id: 'st-drop', name: 'Dropped', key: 'dropped' }]],
  ])
  const userByName = new Map([
    ['alice', [{ id: 'u-1', name: 'Alice' }]],
  ])
  const tagByName = new Map([
    ['vip', [{ id: 't-1', name: 'VIP', key: 'vip' }]],
  ])
  const maps = { statusByName, userByName, tagByName }

  assert.equal(applySingleValueMap('status', 'New', {}, maps).value.id, 'st-new')
  assert.equal(applySingleValueMap('status', 'Lost', {}, maps).needReview, true)
  assert.equal(
    applySingleValueMap('status', 'Lost', { status: { Lost: 'st-drop' } }, maps).value.id,
    'st-drop',
  )
  assert.equal(
    applySingleValueMap('status', 'Lost', { status: { Lost: 'missing-id' } }, maps).needReview,
    true,
  )

  assert.equal(applySingleValueMap('assignedAgent', 'Alice', {}, maps).value.id, 'u-1')
  assert.equal(applySingleValueMap('assignedAgent', 'Bob', {}, maps).needReview, true)

  const tags = applyTagValueMaps('VIP, Hot', {}, maps)
  assert.deepEqual(tags.ids, ['t-1'])
  assert.equal(tags.needReviewMessages.length, 1)

  const mappedTags = applyTagValueMaps('Hot', { tags: { Hot: 't-1' } }, maps)
  assert.deepEqual(mappedTags.ids, ['t-1'])
  assert.equal(mappedTags.needReviewMessages.length, 0)

  const workspace = buildValueMappingWorkspace(
    [{ values: { Status: 'Lost', Source: 'Direct', Tags: 'Hot' } }],
    { Status: 'status', Source: 'source', Tags: 'tags' },
    maps,
  )
  assert.equal(workspace.groups.length, 3)
  const statusGroup = workspace.groups.find((g) => g.field === 'status')
  assert.equal(statusGroup.entries[0].excelValue, 'Lost')
  assert.equal(statusGroup.entries[0].suggestion, null)
})

test('assertConfirmDecisions blocks unresolved catalog Need Review', () => {
  const rows = [{
    excelRowNumber: 9,
    errors: [],
    reviewIssues: ['Lead Source "Direct" is not a known CRM source'],
    duplicate: null,
  }]
  assert.throws(
    () => assertConfirmDecisions(rows, []),
    (error) => /value mapping/i.test(error.message),
  )
})

test('excel import confirm suppresses per-row assignment side effects (source contract)', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const importSrc = fs.readFileSync(
    path.join(__dirname, '../src/services/leadImportService.js'),
    'utf8',
  )
  const leadSrc = fs.readFileSync(
    path.join(__dirname, '../src/services/leadService.js'),
    'utf8',
  )
  assert.match(importSrc, /suppressAssignmentNotifications:\s*true/)
  assert.match(importSrc, /suppressNotifications:\s*true/)
  assert.match(importSrc, /assignmentSummary/)
  assert.match(leadSrc, /suppressAssignmentNotifications/)
  assert.match(leadSrc, /suppressNotifications/)
  assert.equal(typeof assignmentNotifications.notifyLeadPrimaryAssignment, 'function')
  assert.equal(typeof leadService.createLead, 'function')
  assert.equal(typeof leadService.assignLead, 'function')
})
