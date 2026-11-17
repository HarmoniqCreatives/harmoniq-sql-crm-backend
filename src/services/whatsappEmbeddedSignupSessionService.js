const crypto = require('crypto')
const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')
const { whatsappEmbeddedSignupStatuses } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')

const SIGNUP_TTL_MS = 15 * 60 * 1000

/**
 * @param {string} nonce
 * @returns {string}
 */
function hashNonce(nonce) {
  return crypto.createHash('sha256').update(String(nonce), 'utf8').digest('hex')
}

/**
 * Creates a pending Embedded Signup session. Returns plaintext nonce once.
 * Token exchange is P2 — this is session foundation only.
 *
 * @param {object} auth
 * @param {{ ip?: string, requestId?: string }} [meta]
 * @returns {Promise<{ sessionId: string, nonce: string, expiresAt: Date }>}
 */
async function createEmbeddedSignupSession(auth, meta = {}) {
  const { WhatsAppEmbeddedSignupSession } = getModels()
  const nonce = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SIGNUP_TTL_MS)
  const row = await WhatsAppEmbeddedSignupSession.create({
    id: uuidv4(),
    companyId: auth.companyId,
    userId: auth.userId,
    nonceHash: hashNonce(nonce),
    expiresAt,
    consumedAt: null,
    status: whatsappEmbeddedSignupStatuses.pending,
    requestId: meta.requestId || null,
    ip: meta.ip || null,
  })
  return {
    sessionId: row.id,
    nonce,
    expiresAt: row.expiresAt,
  }
}

/**
 * Atomically consumes a pending, unexpired session for the same company + user.
 *
 * @param {object} auth
 * @param {string} nonce
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function consumeEmbeddedSignupSession(auth, nonce, options = {}) {
  const { WhatsAppEmbeddedSignupSession, sequelize } = getModels()
  if (!nonce || typeof nonce !== 'string') {
    throw new AppError(errors.whatsappSignupSessionInvalid, 400)
  }
  const nonceHash = hashNonce(nonce)
  const now = new Date()

  async function run(transaction) {
    const session = await WhatsAppEmbeddedSignupSession.findOne({
      where: {
        nonceHash,
        companyId: auth.companyId,
        userId: auth.userId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
    if (!session) {
      throw new AppError(errors.whatsappSignupSessionInvalid, 400)
    }
    if (session.consumedAt || session.status === whatsappEmbeddedSignupStatuses.consumed) {
      throw new AppError(errors.whatsappSignupSessionConsumed, 400)
    }
    if (session.expiresAt <= now || session.status === whatsappEmbeddedSignupStatuses.expired) {
      session.status = whatsappEmbeddedSignupStatuses.expired
      await session.save({ transaction })
      throw new AppError(errors.whatsappSignupSessionInvalid, 400)
    }
    const [updated] = await WhatsAppEmbeddedSignupSession.update({
      consumedAt: now,
      status: whatsappEmbeddedSignupStatuses.consumed,
    }, {
      where: {
        id: session.id,
        companyId: auth.companyId,
        userId: auth.userId,
        status: whatsappEmbeddedSignupStatuses.pending,
        consumedAt: null,
        expiresAt: { [Op.gt]: now },
      },
      transaction,
    })
    if (!updated) {
      throw new AppError(errors.whatsappSignupSessionConsumed, 400)
    }
    await session.reload({ transaction })
    return session
  }

  if (options.transaction) {
    return run(options.transaction)
  }
  return sequelize.transaction(run)
}

module.exports = {
  SIGNUP_TTL_MS,
  hashNonce,
  createEmbeddedSignupSession,
  consumeEmbeddedSignupSession,
}
