'use strict'

/**
 * Isolated bcryptjs (Mongo CRM) → bcrypt (SQL CRM) compatibility tests.
 * Uses synthetic passwords only. Never loads real user hashes.
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')

const MONGO_BCRYPTJS = path.join(
  '/home/avinash/Documents/Project/faloniq-crm/backend/node_modules/bcryptjs',
)
const SQL_BCRYPT = path.join(
  '/home/avinash/Documents/Project/Harmoniq-creative-crm/backend/node_modules/bcrypt',
)

const bcryptjs = require(MONGO_BCRYPTJS)
const bcrypt = require(SQL_BCRYPT)

const COST = 12
const SYNTHETIC_PASSWORD = `compat-gate-${Date.now()}-x7K9mQ2p`
const WRONG_PASSWORD = `${SYNTHETIC_PASSWORD}-wrong`

describe('passwordCompatibility bcryptjs→bcrypt', () => {
  it('reports package versions under test', () => {
    const jsVer = require(path.join(MONGO_BCRYPTJS, 'package.json')).version
    const nativeVer = require(path.join(SQL_BCRYPT, 'package.json')).version
    assert.equal(jsVer, '3.0.3')
    assert.equal(nativeVer, '6.0.0')
  })

  it('verifies a bcryptjs cost-12 hash with SQL bcrypt (correct password)', async () => {
    const hash = await bcryptjs.hash(SYNTHETIC_PASSWORD, COST)
    assert.match(hash, /^\$2[aby]\$12\$/)
    const ok = await bcrypt.compare(SYNTHETIC_PASSWORD, hash)
    assert.equal(ok, true)
  })

  it('rejects an incorrect password against the same hash', async () => {
    const hash = await bcryptjs.hash(SYNTHETIC_PASSWORD, COST)
    const ok = await bcrypt.compare(WRONG_PASSWORD, hash)
    assert.equal(ok, false)
  })

  it('handles $2b$ prefix hashes from bcryptjs', async () => {
    const hash = await bcryptjs.hash(SYNTHETIC_PASSWORD, COST)
    assert.equal(hash.startsWith('$2b$') || hash.startsWith('$2a$') || hash.startsWith('$2y$'), true)
    // Force documentation of observed prefix
    assert.ok(hash.startsWith('$2b$') || hash.startsWith('$2a$'), `unexpected prefix: ${hash.slice(0, 4)}`)
    const ok = await bcrypt.compare(SYNTHETIC_PASSWORD, hash)
    assert.equal(ok, true)
  })

  it('writes PASS gate status for tested versions (no secrets)', async () => {
    const hash = await bcryptjs.hash(SYNTHETIC_PASSWORD, COST)
    const ok = await bcrypt.compare(SYNTHETIC_PASSWORD, hash)
    const bad = await bcrypt.compare(WRONG_PASSWORD, hash)
    assert.equal(ok, true)
    assert.equal(bad, false)

    const statusPath = path.join(__dirname, '../src/migration/PASSWORD_GATE_STATUS.json')
    const payload = {
      status: 'PASSED',
      testedAt: new Date().toISOString(),
      mongoPackage: 'bcryptjs',
      mongoVersion: require(path.join(MONGO_BCRYPTJS, 'package.json')).version,
      sqlPackage: 'bcrypt',
      sqlVersion: require(path.join(SQL_BCRYPT, 'package.json')).version,
      costFactor: COST,
      syntheticCorrectPasswordVerified: true,
      syntheticWrongPasswordRejected: true,
      observedHashPrefix: hash.slice(0, 4),
      note: 'Synthetic-only test. Does not prove individual production hashes. Real import still requires separate approval.',
    }
    fs.writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`)
    assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'PASSED')
  })
})
