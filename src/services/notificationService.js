const { v4: uuidv4 } = require('uuid')
const modelsApi = require('../models')
const { notificationCategories, userStatuses } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')

/** Live binding so unit tests can mock modelsApi.getModels without MySQL. */
function getModels() {
  return modelsApi.getModels()
}

const ALLOWED_CATEGORIES = new Set(Object.values(notificationCategories))

/**
 * Safe lead payload for in-app notifications — never include phone/email/tokens.
 *
 * @param {{ leadId: string, leadLabel?: string }} input
 * @returns {{ leadId: string, href: string, leadLabel?: string }}
 */
function buildLeadNotificationData(input) {
  const leadId = String(input.leadId || '').trim()
  const data = {
    leadId,
    href: `/leads/${encodeURIComponent(leadId)}`,
  }
  const label = String(input.leadLabel || '').trim()
  if (label) {
    data.leadLabel = label.slice(0, 120)
  }
  return data
}

/**
 * @param {string} companyId
 * @param {string} leadId
 * @param {string} primaryAgentId
 * @returns {string}
 */
function buildLeadAssignedIdempotencyKey({ companyId, leadId, primaryAgentId }) {
  return [
    'lead_assigned',
    String(companyId || ''),
    String(leadId || ''),
    String(primaryAgentId || ''),
  ].join(':')
}

/**
 * @param {string} companyId
 * @param {string} leadId
 * @param {string} transferId
 * @param {string} primaryAgentId
 * @returns {string}
 */
function buildLeadTransferredIdempotencyKey({
  companyId,
  leadId,
  transferId,
  primaryAgentId,
}) {
  return [
    'lead_transferred',
    String(companyId || ''),
    String(leadId || ''),
    String(transferId || ''),
    String(primaryAgentId || ''),
  ].join(':')
}

/**
 * Loads an active recipient in the same company. Cross-company → AppError.
 *
 * @param {string} companyId
 * @param {string} userId
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<object>}
 */
async function assertRecipientInCompany(companyId, userId, transaction) {
  const { User } = getModels()
  const recipientId = String(userId || '').trim()
  const tenantId = String(companyId || '').trim()
  if (!recipientId || !tenantId) {
    throw new AppError(errors.notificationRecipientInvalid, 400)
  }
  const user = await User.findOne({
    where: {
      id: recipientId,
      companyId: tenantId,
      status: userStatuses.active,
    },
    transaction,
  })
  if (!user) {
    throw new AppError(errors.notificationRecipientInvalid, 403)
  }
  return user
}

/**
 * Creates an in-app notification with durable idempotency.
 * Does not send push, email, or WhatsApp.
 *
 * @param {object} input
 * @param {string} input.companyId
 * @param {string} input.userId
 * @param {string} input.category
 * @param {string} input.title
 * @param {string} input.body
 * @param {string} input.idempotencyKey
 * @param {object} [input.data]
 * @param {string} [input.entityType]
 * @param {string} [input.entityId]
 * @param {import('sequelize').Transaction} [input.transaction]
 * @returns {Promise<{ created: boolean, duplicate?: boolean, notification: object|null, reason?: string }>}
 */
async function createNotification(input) {
  const category = String(input.category || '').trim()
  if (!ALLOWED_CATEGORIES.has(category)) {
    throw new AppError(errors.notificationCategoryInvalid, 400)
  }
  const title = String(input.title || '').trim()
  const body = String(input.body || '').trim()
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!idempotencyKey) {
    throw new AppError(errors.notificationIdempotencyRequired, 400)
  }
  if (!title) {
    throw new AppError(errors.notificationTitleRequired, 400)
  }
  if (!body) {
    throw new AppError(errors.notificationBodyRequired, 400)
  }

  const companyId = String(input.companyId || '').trim()
  const userId = String(input.userId || '').trim()
  await assertRecipientInCompany(companyId, userId, input.transaction)

  const { Notification } = getModels()
  const existing = await Notification.findOne({
    where: { companyId, idempotencyKey },
    transaction: input.transaction,
  })
  if (existing) {
    return {
      created: false,
      duplicate: true,
      notification: existing,
      reason: 'duplicate',
    }
  }

  try {
    const notification = await Notification.create({
      id: uuidv4(),
      companyId,
      userId,
      category,
      title: title.slice(0, 200),
      body: body.slice(0, 500),
      data: input.data && typeof input.data === 'object' ? input.data : null,
      entityType: input.entityType ? String(input.entityType).slice(0, 64) : null,
      entityId: input.entityId ? String(input.entityId).slice(0, 36) : null,
      idempotencyKey: idempotencyKey.slice(0, 191),
      readAt: null,
    }, { transaction: input.transaction })
    const created = { created: true, notification }

    /**
     * Durable push queue vs SSE:
     * - With open transaction: queue delivery rows in the SAME transaction so
     *   rollback removes notification + deliveries together. Worker only sees
     *   rows after commit. Sequelize 6.37.8 runs afterCommit hooks in commit()'s
     *   finally (including failed COMMIT) — do NOT rely on afterCommit as the
     *   sole durable queue mechanism.
     * - SSE is best-effort afterCommit, gated by a persisted-row check.
     * - No transaction: queue + SSE immediately via afterNotificationCreated.
     * Missing deliveries are recovered by reconcileMissingPushDeliveries.
     */
    const {
      afterNotificationCreated,
      emitNotificationCreatedSse,
    } = require('./notificationInboxService')
    const { queueDeliveriesForNotification } = require('./notificationPushService')

    if (input.transaction) {
      try {
        await queueDeliveriesForNotification(notification, {
          transaction: input.transaction,
        })
      } catch (error) {
        console.error(JSON.stringify({
          event: 'notification_push_queue_in_txn_failed',
          notificationId: notification.id,
          companyId: notification.companyId,
          userId: notification.userId,
          message: String(error && error.message ? error.message : error),
        }))
        // Fail-soft: notification row remains; reconcile backfills missing pairs.
      }

      if (typeof input.transaction.afterCommit === 'function') {
        input.transaction.afterCommit(() => {
          // SSE only — durable queue already attempted inside the transaction.
          // Existence check guards Sequelize failed-commit finally quirk.
          return emitNotificationCreatedSse(created, { verifyPersisted: true })
            .catch((error) => {
              console.error(JSON.stringify({
                event: 'notification_sse_after_commit_failed',
                notificationId: notification.id,
                message: String(error && error.message ? error.message : error),
              }))
            })
        })
      }
    } else {
      try {
        await afterNotificationCreated(created)
      } catch (error) {
        console.error(JSON.stringify({
          event: 'notification_fanout_failed',
          notificationId: notification.id,
          companyId: notification.companyId,
          userId: notification.userId,
          message: String(error && error.message ? error.message : error),
        }))
      }
    }
    return created
  } catch (error) {
    // Race-safe unique constraint (companyId, idempotencyKey).
    if (error && (error.name === 'SequelizeUniqueConstraintError' || error.parent?.code === 'ER_DUP_ENTRY')) {
      const duplicate = await Notification.findOne({
        where: { companyId, idempotencyKey },
        transaction: input.transaction,
      })
      return {
        created: false,
        duplicate: true,
        notification: duplicate,
        reason: 'duplicate',
      }
    }
    throw error
  }
}

/**
 * Notify primary agent that a lead was assigned (create / first assign / Meta).
 * Fail-soft: returns structured result; callers should catch around this.
 *
 * @param {object} details
 * @returns {Promise<{ created: boolean, duplicate?: boolean, skipped?: boolean, reason?: string, notification?: object|null }>}
 */
async function notifyLeadAssigned(details) {
  const companyId = String(details.companyId || '').trim()
  const leadId = String(details.leadId || '').trim()
  const primaryAgentId = String(details.newPrimaryAgentId || '').trim()
  if (!primaryAgentId) {
    return { created: false, skipped: true, reason: 'no_primary_agent' }
  }
  if (!companyId || !leadId) {
    return { created: false, skipped: true, reason: 'invalid_input' }
  }

  const contactName = String(details.contactName || '').trim() || 'a lead'
  const idempotencyKey = buildLeadAssignedIdempotencyKey({
    companyId,
    leadId,
    primaryAgentId,
  })

  return createNotification({
    companyId,
    userId: primaryAgentId,
    category: notificationCategories.leadAssigned,
    title: 'New lead assigned',
    body: `You were assigned ${contactName}.`,
    idempotencyKey,
    entityType: 'lead',
    entityId: leadId,
    data: buildLeadNotificationData({
      leadId,
      leadLabel: contactName,
    }),
  })
}

/**
 * Notify new primary agent after A→B transfer.
 *
 * @param {object} details
 * @returns {Promise<{ created: boolean, duplicate?: boolean, skipped?: boolean, reason?: string, notification?: object|null }>}
 */
async function notifyLeadTransferred(details) {
  const companyId = String(details.companyId || '').trim()
  const leadId = String(details.leadId || '').trim()
  const previousPrimaryAgentId = details.previousPrimaryAgentId
    ? String(details.previousPrimaryAgentId).trim()
    : ''
  const newPrimaryAgentId = String(details.newPrimaryAgentId || '').trim()
  const transferId = String(details.transferId || '').trim()

  if (!previousPrimaryAgentId || !newPrimaryAgentId) {
    return { created: false, skipped: true, reason: 'not_a_to_b_transfer' }
  }
  if (previousPrimaryAgentId === newPrimaryAgentId) {
    return { created: false, skipped: true, reason: 'unchanged_primary' }
  }
  if (!companyId || !leadId || !transferId) {
    return { created: false, skipped: true, reason: 'invalid_input' }
  }

  const contactName = String(details.contactName || '').trim() || 'a lead'
  const idempotencyKey = buildLeadTransferredIdempotencyKey({
    companyId,
    leadId,
    transferId,
    primaryAgentId: newPrimaryAgentId,
  })

  return createNotification({
    companyId,
    userId: newPrimaryAgentId,
    category: notificationCategories.leadTransferred,
    title: 'Lead transferred to you',
    body: `${contactName} was transferred to you.`,
    idempotencyKey,
    entityType: 'lead',
    entityId: leadId,
    data: buildLeadNotificationData({
      leadId,
      leadLabel: contactName,
    }),
  })
}

/**
 * Meaningful activity schedule for the primary agent (not the actor).
 */
async function notifyLeadActivity(details) {
  const companyId = String(details.companyId || '').trim()
  const leadId = String(details.leadId || '').trim()
  const primaryAgentId = String(details.primaryAgentId || '').trim()
  const actorUserId = String(details.actorUserId || '').trim()
  const activityId = String(details.activityId || '').trim()
  if (!companyId || !leadId || !primaryAgentId || !activityId) {
    return { created: false, skipped: true, reason: 'invalid_input' }
  }
  if (actorUserId && actorUserId === primaryAgentId) {
    return { created: false, skipped: true, reason: 'actor_is_recipient' }
  }
  const contactName = String(details.contactName || '').trim() || 'a lead'
  const activityLabel = String(details.activityLabel || '').trim() || 'an activity'
  return createNotification({
    companyId,
    userId: primaryAgentId,
    category: notificationCategories.leadActivity,
    title: 'Lead activity scheduled',
    body: `${activityLabel} was scheduled for ${contactName}.`,
    idempotencyKey: `lead_activity:${companyId}:${leadId}:${activityId}`,
    entityType: 'lead',
    entityId: leadId,
    data: buildLeadNotificationData({ leadId, leadLabel: contactName }),
  })
}

/**
 * Fail-soft wrappers used by leadService — never throw into the request path.
 *
 * @param {Function} fn
 * @param {object} details
 */
async function safeNotify(fn, details) {
  try {
    return await fn(details)
  } catch (_error) {
    return { created: false, skipped: true, reason: 'notify_failed' }
  }
}

module.exports = {
  ALLOWED_CATEGORIES,
  buildLeadNotificationData,
  buildLeadAssignedIdempotencyKey,
  buildLeadTransferredIdempotencyKey,
  assertRecipientInCompany,
  createNotification,
  notifyLeadAssigned,
  notifyLeadTransferred,
  notifyLeadActivity,
  safeNotify,
}
