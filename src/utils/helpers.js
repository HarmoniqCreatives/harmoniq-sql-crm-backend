const crypto = require('crypto')
const bcrypt = require('bcrypt')
const { security } = require('../config/security')
const { AppError, errors } = require('./errors')

function readText(body, key) {
  if (!body || typeof body[key] !== 'string') {
    return ''
  }
  return body[key].trim()
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function normalizeNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) {
    return `+${digits.slice(1).replace(/\D/g, '')}`
  }
  return digits.replace(/\D/g, '')
}

function isInternationalPhone(value) {
  return /^\+[1-9]\d{7,14}$/.test(value)
}

function isWithinLength(value, max) {
  return String(value || '').length <= max
}

function createSecretToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function hashSecret(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

async function hashPassword(password) {
  return bcrypt.hash(password, security.bcryptRounds)
}

async function checkPassword(password, passwordHash) {
  if (!passwordHash) {
    return false
  }
  return bcrypt.compare(password, passwordHash)
}

function requirePassword(password) {
  if (!password) {
    throw new AppError(errors.passwordRequired, 400)
  }
  if (String(password).length < security.passwordMinLength) {
    throw new AppError(errors.passwordTooShort, 400)
  }
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000)
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

/** UUID v4-ish check for route params (Sequelize CHAR(36) ids). */
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
}

module.exports = {
  readText,
  normalizeEmail,
  isEmail,
  normalizeNameKey,
  normalizePhone,
  isInternationalPhone,
  isWithinLength,
  createSecretToken,
  hashSecret,
  hashPassword,
  checkPassword,
  requirePassword,
  addHours,
  addDays,
  addMinutes,
  isUuid,
}
