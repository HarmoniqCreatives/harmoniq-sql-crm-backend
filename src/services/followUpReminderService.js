'use strict'

const { Op } = require('sequelize')
const { getModels } = require('../models')
const {
  followUpReminderMinutesOptions,
  notificationCategories,
} = require('../utils/enums')
const {
  createNotification,
  buildLeadNotificationData,
  safeNotify,
} = require('./notificationService')

/**
 * Follow-up reminders based on Lead.nextFollowUpAt.
 *
 * Rules:
 * - Fire once per scheduled follow-up, leadMinutes before nextFollowUpAt (company setting).
 * - Recipient = current primaryAgentId.
 * - Reschedule changes idempotency key; clear nextFollowUpAt drops from scan.
 * - Overdue leads are not re-notified (presentation-only overdue in CRM).
 * - Idempotency: follow_up:{companyId}:{leadId}:{scheduledInstantIso}
 */

const DEFAULT_LEAD_MINUTES = 5

function pad(n) {
  return String(n).padStart(2, '0')
}

/**
 * Stable UTC instant key for a scheduled follow-up (to the minute).
 * @param {Date|string|number} date
 * @returns {string}
 */
function scheduledInstantKey(date) {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}

/** @deprecated use scheduledInstantKey — kept for existing unit tests */
function minuteKeyFromDate(date) {
  return scheduledInstantKey(date).replace(/Z$/, '')
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function normalizeLeadMinutes(raw) {
  const n = Number(raw)
  if (followUpReminderMinutesOptions.includes(n)) {
    return n
  }
  return DEFAULT_LEAD_MINUTES
}

/**
 * @param {Date|string|number} followUpAt
 * @param {number} leadMinutes
 * @returns {Date|null}
 */
function reminderDueAt(followUpAt, leadMinutes) {
  const followUp = new Date(followUpAt)
  if (Number.isNaN(followUp.getTime())) return null
  const minutes = normalizeLeadMinutes(leadMinutes)
  return new Date(followUp.getTime() - minutes * 60 * 1000)
}

async function notifyFollowUpReminder(details) {
  const companyId = String(details.companyId || '').trim()
  const leadId = String(details.leadId || '').trim()
  const primaryAgentId = String(details.primaryAgentId || '').trim()
  const followUpAt = details.followUpAt
  if (!companyId || !leadId || !primaryAgentId || !followUpAt) {
    return { created: false, skipped: true, reason: 'invalid_input' }
  }
  const instantKey = scheduledInstantKey(followUpAt)
  if (!instantKey) {
    return { created: false, skipped: true, reason: 'invalid_follow_up' }
  }
  const contactName = String(details.contactName || '').trim() || 'a lead'
  const result = await createNotification({
    companyId,
    userId: primaryAgentId,
    category: notificationCategories.followUp,
    title: 'Follow-up reminder',
    body: `Follow up with ${contactName}.`,
    idempotencyKey: `follow_up:${companyId}:${leadId}:${instantKey}`,
    entityType: 'lead',
    entityId: leadId,
    data: buildLeadNotificationData({ leadId, leadLabel: contactName }),
  })
  return result
}

/**
 * Scans leads whose reminder-due instant (nextFollowUpAt - company lead minutes)
 * falls in [now - lookback, now + ahead]. Never re-notifies purely overdue schedules.
 *
 * @param {object} [options]
 */
async function processDueFollowUpReminders(options = {}) {
  const { Lead, Company } = getModels()
  const now = options.now ? new Date(options.now) : new Date()
  const lookbackMs = Number(options.lookbackMs) || 15 * 60 * 1000
  const aheadMs = Number(options.aheadMs) || 2 * 60 * 1000
  const maxLeadMs = Math.max(...followUpReminderMinutesOptions) * 60 * 1000

  // Broad SQL window: reminder due = followUp - leadMinutes, so followUp is in
  // [now - lookback + leadMin, now + ahead + leadMax] ⊆ [now - lookback, now + ahead + maxLead].
  const from = new Date(now.getTime() - lookbackMs)
  const to = new Date(now.getTime() + aheadMs + maxLeadMs)

  const leads = await Lead.findAll({
    where: {
      nextFollowUpAt: { [Op.between]: [from, to] },
      primaryAgentId: { [Op.ne]: null },
    },
    attributes: ['id', 'companyId', 'primaryAgentId', 'name', 'nextFollowUpAt'],
    limit: Number(options.limit) || 200,
  })

  const companyIds = [...new Set(leads.map((row) => row.companyId))]
  const companies = companyIds.length
    ? await Company.findAll({
      where: { id: { [Op.in]: companyIds } },
      attributes: ['id', 'timezone', 'followUpReminderMinutes'],
    })
    : []
  const companyById = new Map(companies.map((row) => [row.id, row]))

  const windowStart = now.getTime() - lookbackMs
  const windowEnd = now.getTime() + aheadMs

  let created = 0
  let skipped = 0
  for (const lead of leads) {
    const company = companyById.get(lead.companyId)
    const leadMinutes = normalizeLeadMinutes(company && company.followUpReminderMinutes)
    const due = reminderDueAt(lead.nextFollowUpAt, leadMinutes)
    if (!due) {
      skipped += 1
      continue
    }
    const dueMs = due.getTime()
    // Only fire in the reminder window — not after the follow-up is overdue for re-nag.
    if (dueMs < windowStart || dueMs > windowEnd) {
      skipped += 1
      continue
    }
    // Do not notify if follow-up itself is already far past (overdue CRM display only).
    if (new Date(lead.nextFollowUpAt).getTime() < now.getTime() - aheadMs) {
      skipped += 1
      continue
    }

    const result = await safeNotify(notifyFollowUpReminder, {
      companyId: lead.companyId,
      leadId: lead.id,
      primaryAgentId: lead.primaryAgentId,
      contactName: lead.name,
      followUpAt: lead.nextFollowUpAt,
      timezone: company && company.timezone,
      leadMinutes,
    })
    if (result && result.created) {
      created += 1
    } else {
      skipped += 1
    }
  }
  return { scanned: leads.length, created, skipped }
}

let reminderTimer = null

function startFollowUpReminderWorker() {
  if (process.env.NODE_ENV === 'test') return
  if (String(process.env.FOLLOW_UP_REMINDER_ENABLED || '1') === '0') return
  if (reminderTimer) return
  const ms = Math.max(30000, Number(process.env.FOLLOW_UP_REMINDER_INTERVAL_MS) || 60000)
  reminderTimer = setInterval(() => {
    processDueFollowUpReminders().catch((error) => {
      console.error('[follow-up-reminder]', error.message)
    })
  }, ms)
  if (typeof reminderTimer.unref === 'function') reminderTimer.unref()
}

function stopFollowUpReminderWorker() {
  if (reminderTimer) {
    clearInterval(reminderTimer)
    reminderTimer = null
  }
}

module.exports = {
  DEFAULT_LEAD_MINUTES,
  minuteKeyFromDate,
  scheduledInstantKey,
  normalizeLeadMinutes,
  reminderDueAt,
  notifyFollowUpReminder,
  processDueFollowUpReminders,
  startFollowUpReminderWorker,
  stopFollowUpReminderWorker,
}
