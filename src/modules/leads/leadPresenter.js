const { isOverdue } = require('../../services/leadOverdue')
const { messages } = require('../../utils/messages')

/**
 * Builds the public lead response shape used by list and detail.
 * Omits internal fields (deletedBy, metaLeadId, password hashes, etc.).
 *
 * @param {object} lead
 * @param {Map<string, object>} itemMap
 * @param {Map<string, object>} userMap
 * @param {string} timeZone
 * @returns {object}
 */
function presentLead(lead, itemMap, userMap, timeZone) {
  const status = itemMap.get(lead.statusId)
  const statusView = status ? { id: status.id, name: status.name, key: status.key } : null
  const tags = []
  const tagRows = lead.tagRows || []
  for (const row of tagRows) {
    const tag = itemMap.get(row.tagId)
    if (tag) {
      tags.push({ id: tag.id, name: tag.name, tone: tag.tone })
    }
  }
  const primary = userMap.get(lead.primaryAgentId)
  const secondary = userMap.get(lead.secondaryAgentId)
  const originalPrimary = readOriginalPrimaryUser(lead, userMap)
  const feedbacks = (lead.feedbacks || []).map((item) => ({
    type: item.type,
    text: item.text,
    createdAt: item.createdAt,
  }))
  const notes = presentNotes(lead, userMap)
  const transfers = presentTransfers(lead)
  const activities = presentActivities(lead, itemMap, userMap, timeZone)
  const history = presentHistory(lead, itemMap, userMap, timeZone)
  return {
    id: lead.id,
    number: lead.number,
    label: `#${lead.number}`,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    status: statusView,
    tags,
    primaryAgent: primary ? { id: primary.id, name: primary.name } : null,
    secondaryAgent: secondary ? { id: secondary.id, name: secondary.name } : null,
    originalPrimaryAgent: originalPrimary ? { id: originalPrimary.id, name: originalPrimary.name } : null,
    campaignName: lead.campaignName || '',
    branchId: lead.branchId || null,
    teamId: lead.teamId || null,
    propertyType: lead.propertyType,
    purpose: lead.purpose,
    location: lead.location,
    budget: lead.budget,
    currency: lead.currency,
    builtUpArea: lead.builtUpArea,
    carpetArea: lead.carpetArea,
    readiness: lead.readiness,
    nextFollowUpAt: lead.nextFollowUpAt || null,
    feedbacks,
    transfers,
    notes,
    activities,
    history,
    createdAt: lead.createdAt,
  }
}

/**
 * Original assignee survives later transfers.
 * Prefer the previous-primary who never appears as a transfer target (stable when
 * DATETIME second precision collapses multiple transfers onto the same timestamp).
 *
 * @param {object} lead
 * @param {Map<string, object>} userMap
 * @returns {object|null}
 */
function readOriginalPrimaryUser(lead, userMap) {
  const transfers = lead.transfers || []
  if (transfers.length === 0) {
    return userMap.get(lead.primaryAgentId) || null
  }
  const newPrimaryIds = new Set(transfers.map((item) => String(item.primaryAgentId)))
  for (const item of transfers) {
    if (item.previousPrimaryAgentId && !newPrimaryIds.has(String(item.previousPrimaryAgentId))) {
      return userMap.get(item.previousPrimaryAgentId) || null
    }
  }
  const sorted = [...transfers].sort((left, right) => {
    const byTime = new Date(left.createdAt) - new Date(right.createdAt)
    if (byTime !== 0) {
      return byTime
    }
    return String(left.id).localeCompare(String(right.id))
  })
  const first = sorted[0]
  if (first.previousPrimaryAgentId) {
    return userMap.get(first.previousPrimaryAgentId) || null
  }
  return userMap.get(first.primaryAgentId) || null
}

/**
 * @param {object} lead
 * @returns {object[]}
 */
function presentTransfers(lead) {
  return (lead.transfers || []).map((item) => ({
    previousPrimaryAgentId: item.previousPrimaryAgentId || null,
    primaryAgentId: item.primaryAgentId,
    secondaryAgentId: item.secondaryAgentId || null,
    reason: item.reason,
    transferredBy: item.transferredBy,
    createdAt: item.createdAt,
  }))
}

/**
 * @param {Map<string, object>} userMap
 * @param {string|null|undefined} userId
 * @returns {string}
 */
function personName(userMap, userId) {
  if (!userId) {
    return ''
  }
  const user = userMap.get(userId)
  return user ? user.name : ''
}

/**
 * @param {object} lead
 * @param {Map<string, object>} userMap
 * @returns {object[]}
 */
function presentNotes(lead, userMap) {
  return (lead.notes || []).map((item) => ({
    text: item.text,
    createdBy: item.createdBy,
    createdByName: personName(userMap, item.createdBy),
    createdAt: item.createdAt,
  }))
}

/**
 * @param {object} lead
 * @param {Map<string, object>} itemMap
 * @param {Map<string, object>} userMap
 * @param {string} timeZone
 * @returns {object[]}
 */
function presentActivities(lead, itemMap, userMap, timeZone) {
  return (lead.activities || []).map((item) => {
    const activityType = itemMap.get(item.activityTypeId)
    return {
      activityTypeId: item.activityTypeId,
      activityTypeName: activityType ? activityType.name : '',
      agentId: item.agentId,
      agentName: personName(userMap, item.agentId),
      scheduledAt: item.scheduledAt,
      createdBy: item.createdBy,
      createdByName: personName(userMap, item.createdBy),
      createdAt: item.createdAt,
      overdue: isOverdue(item.scheduledAt, timeZone),
    }
  })
}

/**
 * Combined timeline (newest first) matching legacy history shape.
 *
 * @param {object} lead
 * @param {Map<string, object>} itemMap
 * @param {Map<string, object>} userMap
 * @param {string} timeZone
 * @returns {object[]}
 */
function presentHistory(lead, itemMap, userMap, timeZone) {
  const history = [{
    kind: 'created',
    text: messages.historyCreated,
    createdAt: lead.createdAt,
    scheduledAt: null,
    overdue: false,
  }]
  for (const item of lead.feedbacks || []) {
    history.push({
      kind: 'feedback',
      text: item.text,
      detail: item.type,
      createdAt: item.createdAt,
      scheduledAt: null,
      overdue: false,
    })
  }
  for (const item of lead.notes || []) {
    history.push({
      kind: 'note',
      text: item.text,
      createdAt: item.createdAt,
      scheduledAt: null,
      overdue: false,
    })
  }
  for (const item of lead.transfers || []) {
    history.push({
      kind: 'transfer',
      text: transferHistoryText(item, userMap),
      createdAt: item.createdAt,
      scheduledAt: null,
      overdue: false,
    })
  }
  for (const item of lead.activities || []) {
    const activityType = itemMap.get(item.activityTypeId)
    history.push({
      kind: 'activity',
      text: `${activityType ? activityType.name : ''} · ${personName(userMap, item.agentId)}`,
      createdAt: item.createdAt,
      scheduledAt: item.scheduledAt,
      overdue: isOverdue(item.scheduledAt, timeZone),
    })
  }
  history.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
  return history
}

/**
 * @param {object} item
 * @param {Map<string, object>} userMap
 * @returns {string}
 */
function transferHistoryText(item, userMap) {
  const nextName = personName(userMap, item.primaryAgentId)
  const previousName = personName(userMap, item.previousPrimaryAgentId)
  let text = nextName
  if (previousName) {
    text = `${previousName} → ${nextName}`
  }
  if (item.reason) {
    text = `${text}. ${item.reason}`
  }
  const byName = personName(userMap, item.transferredBy)
  if (byName) {
    text = `${text}. ${byName}`
  }
  return text
}

module.exports = {
  presentLead,
  readOriginalPrimaryUser,
}
