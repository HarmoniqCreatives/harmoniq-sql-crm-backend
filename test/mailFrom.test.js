const assert = require('node:assert/strict')
const { afterEach, test } = require('node:test')
const { AppError, errors } = require('../src/utils/errors')
const {
  DEFAULT_MAIL_FROM_NAME,
  resolveMailFrom,
  resolveMailFromName,
  sendAssignmentEmail,
  clearMemoryOutbox,
  getMemoryOutbox,
} = require('../src/services/mailService')

const mailKeys = [
  'MAIL_FROM',
  'MAIL_FROM_EMAIL',
  'MAIL_FROM_NAME',
  'MAIL_DRIVER',
  'MAIL_PROVIDER',
]
const saved = {}

for (const key of mailKeys) {
  saved[key] = process.env[key]
}

afterEach(() => {
  for (const key of mailKeys) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
})

test('DEFAULT_MAIL_FROM_NAME is Melo', () => {
  assert.equal(DEFAULT_MAIL_FROM_NAME, 'Melo')
})

test('MAIL_FROM_EMAIL builds From with Melo when MAIL_FROM_NAME is unset', () => {
  delete process.env.MAIL_FROM
  delete process.env.MAIL_FROM_NAME
  process.env.MAIL_FROM_EMAIL = 'erp.accounts@suvidretail.in'
  assert.equal(resolveMailFromName(), 'Melo')
  assert.equal(resolveMailFrom(), 'Melo <erp.accounts@suvidretail.in>')
})

test('MAIL_FROM_NAME overrides the default display name', () => {
  delete process.env.MAIL_FROM
  process.env.MAIL_FROM_EMAIL = 'alerts@example.com'
  process.env.MAIL_FROM_NAME = 'Ops Desk'
  assert.equal(resolveMailFrom(), 'Ops Desk <alerts@example.com>')
})

test('legacy MAIL_FROM keeps the email but forces Melo as display name', () => {
  delete process.env.MAIL_FROM_EMAIL
  delete process.env.MAIL_FROM_NAME
  process.env.MAIL_FROM = 'Harmoniq Creatives <erp.accounts@suvidretail.in>'
  assert.equal(resolveMailFrom(), 'Melo <erp.accounts@suvidretail.in>')
})

test('legacy MAIL_FROM with MAIL_FROM_NAME uses the configured name', () => {
  delete process.env.MAIL_FROM_EMAIL
  process.env.MAIL_FROM = 'Harmoniq Creatives <erp.accounts@suvidretail.in>'
  process.env.MAIL_FROM_NAME = 'Melo'
  assert.equal(resolveMailFrom(), 'Melo <erp.accounts@suvidretail.in>')
})

test('rejects an invalid MAIL_FROM_EMAIL', () => {
  delete process.env.MAIL_FROM
  process.env.MAIL_FROM_EMAIL = 'not-an-email'
  assert.throws(() => resolveMailFrom(), (error) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.message, errors.mailFromEmailInvalid)
    return true
  })
})

test('automatic assignment emails use the resolved Melo From header', async () => {
  process.env.MAIL_DRIVER = 'memory'
  delete process.env.MAIL_FROM_EMAIL
  delete process.env.MAIL_FROM_NAME
  process.env.MAIL_FROM = 'Harmoniq Creatives <erp.accounts@suvidretail.in>'
  clearMemoryOutbox()
  await sendAssignmentEmail({
    to: 'agent@example.com',
    assignedBy: 'Admin',
    contactName: 'Ada',
    contactNumber: '+971501234567',
    emailKind: 'new_lead',
  })
  const newest = getMemoryOutbox().at(-1)
  assert.equal(newest.from, 'Melo <erp.accounts@suvidretail.in>')
})
