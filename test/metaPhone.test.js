const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  normalizeMetaLeadPhone,
  resolveCompanyDialCode,
  metaPhoneDebugEvent,
} = require('../src/utils/metaPhone')

test('accepts E.164 with plus and formatting', () => {
  const result = normalizeMetaLeadPhone('+971 50-123-4567', { timezone: 'Asia/Dubai' })
  assert.equal(result.ok, true)
  assert.equal(result.phone, '+971501234567')
})

test('accepts 00-prefix international without inventing dial', () => {
  const result = normalizeMetaLeadPhone('00971501234567', { timezone: 'Asia/Kolkata' })
  assert.equal(result.ok, true)
  assert.equal(result.phone, '+971501234567')
})

test('accepts bare digits that already include a known dial code', () => {
  const result = normalizeMetaLeadPhone('971501234567', { baseCurrency: 'USD' })
  assert.equal(result.ok, true)
  assert.equal(result.phone, '+971501234567')
})

test('applies India dial for local national under Asia/Kolkata', () => {
  const result = normalizeMetaLeadPhone('9876543210', { timezone: 'Asia/Kolkata' })
  assert.equal(result.ok, true)
  assert.equal(result.phone, '+919876543210')
})

test('strips leading zero and applies Dubai dial', () => {
  const result = normalizeMetaLeadPhone('(050) 123-4567', { timezone: 'Asia/Dubai' })
  assert.equal(result.ok, true)
  assert.equal(result.phone, '+971501234567')
})

test('applies Pakistan dial from currency when timezone unknown', () => {
  const result = normalizeMetaLeadPhone('03001234567', { baseCurrency: 'PKR' })
  assert.equal(result.ok, true)
  assert.equal(result.phone, '+923001234567')
})

test('does not invent country code when context is ambiguous (USD)', () => {
  const result = normalizeMetaLeadPhone('9876543210', { baseCurrency: 'USD' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ambiguous_country')
  assert.equal(result.phone, '')
})

test('does not invent country code when timezone and currency are unset', () => {
  const result = normalizeMetaLeadPhone('501234567', {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ambiguous_country')
})

test('rejects invalid / too-short phones', () => {
  const result = normalizeMetaLeadPhone('12345', { timezone: 'Asia/Dubai' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_national')
  assert.equal(result.phone, '')
})

test('rejects empty phone', () => {
  const result = normalizeMetaLeadPhone('   ', { timezone: 'Asia/Kolkata' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
})

test('timezone dial resolution prefers timezone over currency', () => {
  assert.equal(resolveCompanyDialCode({ timezone: 'Asia/Dubai', baseCurrency: 'INR' }), '+971')
  assert.equal(resolveCompanyDialCode({ timezone: 'Asia/Kolkata' }), '+91')
  assert.equal(resolveCompanyDialCode({ baseCurrency: 'AED' }), '+971')
  assert.equal(resolveCompanyDialCode({ baseCurrency: 'USD' }), '')
})

test('debug event never includes raw or normalized phone', () => {
  const result = normalizeMetaLeadPhone('+971501234567', { timezone: 'Asia/Dubai' })
  const event = metaPhoneDebugEvent(result, { companyId: 'c1', leadgenId: 'l1' })
  const serialized = JSON.stringify(event)
  assert.equal(serialized.includes('971501234567'), false)
  assert.equal(serialized.includes('+971'), false)
  assert.equal(event.ok, true)
  assert.equal(event.rawHasPlus, true)
})
