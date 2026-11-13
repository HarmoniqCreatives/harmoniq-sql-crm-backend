const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { readEnv } = require('../config/env')
const { security } = require('../config/security')
const { getModels } = require('../models')
const { AppError, errors } = require('../utils/errors')
const {
  addDays,
  createSecretToken,
  hashSecret,
} = require('../utils/helpers')

/**
 * Access JWT + opaque refresh session lifecycle.
 * Refresh tokens are stored hashed; rotation and reuse detection protect sessions.
 */

/**
 * @param {object} payload sub, companyId, roleId, sid
 * @returns {string}
 */
function signAccessToken(payload) {
  const env = readEnv()
  return jwt.sign(payload, env.jwtAccessSecret, {
    expiresIn: security.accessTokenTtl,
  })
}

function verifyAccessToken(token) {
  const env = readEnv()
  try {
    return jwt.verify(token, env.jwtAccessSecret)
  } catch (error) {
    throw new AppError(errors.unauthorized, 401)
  }
}

/**
 * Creates a hashed refresh session and signs a short-lived access JWT.
 *
 * @param {object} user Sequelize user with companyId/roleId
 * @param {{ familyId?: string, userAgent?: string, ipAddress?: string }} [meta]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: Date, sessionId: string, familyId: string }>}
 */
async function createSession(user, meta = {}) {
  const { Session } = getModels()
  const refreshToken = createSecretToken()
  const sessionId = uuidv4()
  const familyId = meta.familyId || uuidv4()
  const expiresAt = addDays(new Date(), security.refreshTokenDays)
  await Session.create({
    id: sessionId,
    companyId: user.companyId,
    userId: user.id,
    tokenHash: hashSecret(refreshToken),
    familyId,
    expiresAt,
    userAgent: meta.userAgent || null,
    ipAddress: meta.ipAddress || null,
  })
  const accessToken = signAccessToken({
    sub: user.id,
    companyId: user.companyId,
    roleId: user.roleId,
    sid: sessionId,
  })
  return {
    accessToken,
    refreshToken,
    expiresAt,
    sessionId,
    familyId,
  }
}

/**
 * Rotates a refresh token. Reuse of a revoked token revokes the entire family.
 *
 * @param {string} refreshToken raw refresh token
 * @param {object} [meta]
 * @returns {Promise<object>} new token pair
 */
async function rotateRefreshToken(refreshToken, meta = {}) {
  const { Session, User } = getModels()
  const tokenHash = hashSecret(refreshToken)
  const existing = await Session.findOne({ where: { tokenHash } })
  if (!existing) {
    throw new AppError(errors.refreshInvalid, 401)
  }
  if (existing.revokedAt) {
    await Session.update(
      { revokedAt: new Date() },
      { where: { familyId: existing.familyId, revokedAt: null } },
    )
    throw new AppError(errors.refreshInvalid, 401)
  }
  if (existing.expiresAt.getTime() < Date.now()) {
    throw new AppError(errors.refreshInvalid, 401)
  }
  const user = await User.findByPk(existing.userId)
  if (!user || user.companyId !== existing.companyId) {
    throw new AppError(errors.refreshInvalid, 401)
  }
  const next = await createSession(user, {
    familyId: existing.familyId,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  })
  existing.revokedAt = new Date()
  existing.replacedBySessionId = next.sessionId
  await existing.save()
  return next
}

async function revokeRefreshToken(refreshToken) {
  const { Session } = getModels()
  const tokenHash = hashSecret(refreshToken)
  const existing = await Session.findOne({ where: { tokenHash } })
  if (!existing) {
    return
  }
  if (!existing.revokedAt) {
    existing.revokedAt = new Date()
    await existing.save()
  }
}

async function revokeAllUserSessions(userId) {
  const { Session } = getModels()
  await Session.update(
    { revokedAt: new Date() },
    { where: { userId, revokedAt: null } },
  )
}

async function assertSessionActive(sessionId, userId, companyId) {
  const { Session } = getModels()
  const session = await Session.findByPk(sessionId)
  if (!session || session.userId !== userId || session.companyId !== companyId) {
    throw new AppError(errors.unauthorized, 401)
  }
  if (session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw new AppError(errors.unauthorized, 401)
  }
  return session
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  createSession,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserSessions,
  assertSessionActive,
}
