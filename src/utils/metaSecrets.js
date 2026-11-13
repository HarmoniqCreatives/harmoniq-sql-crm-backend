const crypto = require('crypto')
const { AppError, errors } = require('./errors')

const DEFAULT_KEY_VERSION = 1

/**
 * Decodes META_TOKEN_ENCRYPTION_KEY as 32 raw bytes (hex or base64).
 *
 * @param {string} value
 * @returns {Buffer|null}
 */
function decodeEncryptionKey(value) {
  if (typeof value !== 'string' || !value) {
    return null
  }
  let buffer
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    buffer = Buffer.from(value, 'hex')
  } else {
    try {
      buffer = Buffer.from(value, 'base64')
    } catch {
      return null
    }
  }
  if (buffer.length !== 32) {
    return null
  }
  return buffer
}

/**
 * Fails process startup when the Meta encryption key is missing or not 32 bytes.
 * Required before any Meta secret can be stored safely.
 */
function assertMetaEncryptionKey() {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(errors.metaKeyMissing)
  }
  if (!decodeEncryptionKey(raw)) {
    throw new Error(errors.metaKeyInvalid)
  }
}

function readKeyVersion() {
  const raw = Number(process.env.META_TOKEN_ENCRYPTION_KEY_VERSION || DEFAULT_KEY_VERSION)
  if (!Number.isInteger(raw) || raw < 1) {
    return DEFAULT_KEY_VERSION
  }
  return raw
}

function readEncryptionKey() {
  const key = decodeEncryptionKey(process.env.META_TOKEN_ENCRYPTION_KEY)
  if (!key) {
    throw new AppError(errors.metaKeyMissing, 500)
  }
  return key
}

/**
 * Encrypts a Meta secret with AES-256-GCM.
 * Stores keyVersion so rotation can decrypt historical ciphertext later.
 *
 * @param {string} plain
 * @returns {{ cipherText: string, iv: string, tag: string, keyVersion: number }}
 */
function encryptSecret(plain) {
  const key = readEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: readKeyVersion(),
  }
}

/**
 * Decrypts ciphertext produced by encryptSecret. Rejects tampered payloads.
 *
 * @param {{ cipherText: string, iv: string, tag: string, keyVersion?: number }} stored
 * @returns {string}
 */
function decryptSecret(stored) {
  if (!stored || !stored.cipherText || !stored.iv || !stored.tag) {
    throw new AppError(errors.metaCipherInvalid, 500)
  }
  const key = readEncryptionKey()
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(stored.cipherText, 'base64')),
      decipher.final(),
    ])
    return plain.toString('utf8')
  } catch {
    throw new AppError(errors.metaCipherInvalid, 500)
  }
}

module.exports = {
  assertMetaEncryptionKey,
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  readKeyVersion,
}
