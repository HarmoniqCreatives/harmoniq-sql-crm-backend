'use strict'

const bcrypt = require('bcrypt')

/** bcrypt digests look like $2a$10$... or $2b$/$2y$ */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

/**
 * Structural check only — never logs the hash.
 * @param {string} passwordHash
 */
function isBcryptHashFormat(passwordHash) {
  if (typeof passwordHash !== 'string' || !passwordHash) {
    return false
  }
  return BCRYPT_HASH_RE.test(passwordHash)
}

/**
 * Staging compatibility probe: verify a known password against a hash using SQL bcrypt.
 * Call with a dedicated test account only. Never print hash or password.
 *
 * @param {{ password: string, passwordHash: string, compareFn?: Function }} input
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function runPasswordCompatibilityTest(input) {
  const password = input && input.password
  const passwordHash = input && input.passwordHash
  const compareFn = input.compareFn || ((p, h) => bcrypt.compare(p, h))

  if (!password || typeof password !== 'string') {
    return { ok: false, reason: 'password_missing' }
  }
  if (!isBcryptHashFormat(passwordHash)) {
    return { ok: false, reason: 'hash_format_invalid' }
  }
  try {
    const matches = await compareFn(password, passwordHash)
    if (!matches) {
      return { ok: false, reason: 'compare_failed' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'compare_threw' }
  }
}

/**
 * Import must refuse to copy hashes until this gate is marked passed.
 */
function assertPasswordGate(gate) {
  if (!gate || gate.passed !== true) {
    const err = new Error('PASSWORD_COMPATIBILITY_GATE_BLOCKED')
    err.code = 'PASSWORD_COMPATIBILITY_GATE_BLOCKED'
    throw err
  }
}

module.exports = {
  isBcryptHashFormat,
  runPasswordCompatibilityTest,
  assertPasswordGate,
  BCRYPT_HASH_RE,
}
