const { getModels } = require('../../models')
const { security } = require('../../config/security')
const { calendarDate } = require('../../services/leadOverdue')
const {
  catalogKinds,
  feedbackTypes,
  leadPurposes,
  leadSources,
  propertyTypes,
  readinessValues,
  roleScopes,
  userStatuses,
} = require('../../utils/enums')
const { AppError, errors } = require('../../utils/errors')
const {
  isEmail,
  isInternationalPhone,
  isUuid,
  isWithinLength,
  normalizeEmail,
  normalizePhone,
  readText,
} = require('../../utils/helpers')

const feedbackTextLimit = 2000
const textLimit = 300
const maxTagIds = 20

/**
 * Shared create/edit lead field validation (legacy parity).
 * Status must be an active catalog STATUS in the same company.
 * Tags/activity types follow the same tenant + active rules.
 * Cross-tenant or unknown IDs → 404 (no existence leak).
 */

/**
 * @param {object} body
 * @param {string} fieldName
 * @param {Record<string, string>} values
 * @param {string} message
 * @param {string} [fallback]
 * @returns {string}
 */
function readEnum(body, fieldName, values, message, fallback) {
  const value = readText(body, fieldName)
  if (!value) {
    return fallback
  }
  if (!Object.values(values).includes(value)) {
    throw new AppError(message, 400)
  }
  return value
}

/**
 * @param {object} body
 * @param {string} fieldName
 * @returns {string}
 */
function readLimitedText(body, fieldName) {
  const text = readText(body, fieldName)
  if (!isWithinLength(text, textLimit)) {
    throw new AppError(errors.valueTooLong, 400)
  }
  return text
}

/**
 * @param {object} auth
 * @param {object} body
 * @returns {Promise<object>}
 */
async function readStatus(auth, body) {
  const { CatalogItem } = getModels()
  const statusId = readText(body, 'statusId')
  if (!isUuid(statusId)) {
    throw new AppError(errors.invalidId, 400)
  }
  const status = await CatalogItem.findOne({
    where: {
      id: statusId,
      companyId: auth.companyId,
      kind: catalogKinds.status,
    },
  })
  if (!status) {
    throw new AppError(errors.catalogNotFound, 404)
  }
  if (!status.isActive) {
    throw new AppError(errors.statusInactive, 400)
  }
  return status
}

/**
 * @param {object} auth
 * @param {object} body
 * @returns {Promise<object[]>}
 */
async function readTags(auth, body) {
  const { CatalogItem } = getModels()
  if (!Object.prototype.hasOwnProperty.call(body, 'tagIds')) {
    return []
  }
  if (!Array.isArray(body.tagIds)) {
    throw new AppError(errors.tagInvalid, 400)
  }
  if (body.tagIds.length > maxTagIds) {
    throw new AppError(errors.valueTooLong, 400)
  }
  const tags = []
  for (const tagId of body.tagIds) {
    if (!isUuid(tagId)) {
      throw new AppError(errors.invalidId, 400)
    }
    const tag = await CatalogItem.findOne({
      where: {
        id: tagId,
        companyId: auth.companyId,
        kind: catalogKinds.tag,
      },
    })
    if (!tag) {
      throw new AppError(errors.catalogNotFound, 404)
    }
    if (!tag.isActive) {
      throw new AppError(errors.tagInvalid, 400)
    }
    tags.push(tag)
  }
  return tags
}

/**
 * @param {object} auth
 * @param {string} agentId
 * @returns {Promise<object|null>}
 */
async function readAgent(auth, agentId) {
  const { User } = getModels()
  if (!agentId) {
    return null
  }
  if (!isUuid(agentId)) {
    throw new AppError(errors.invalidId, 400)
  }
  const agent = await User.findOne({
    where: {
      id: agentId,
      companyId: auth.companyId,
      status: userStatuses.active,
    },
  })
  if (!agent) {
    throw new AppError(errors.agentNotFound, 404)
  }
  return agent
}

/**
 * @param {object} auth
 * @param {object} body
 * @returns {Promise<{ primary: object|null, secondary: object|null }>}
 */
async function readAgents(auth, body) {
  let primaryId = readText(body, 'primaryAgentId')
  const secondaryId = readText(body, 'secondaryAgentId')
  if (!auth.role?.isProtected && auth.role?.scope === roleScopes.own) {
    if (primaryId) {
      if (primaryId !== auth.userId) {
        throw new AppError(errors.outsideScope, 403)
      }
    } else {
      primaryId = auth.userId
    }
  }
  const primary = await readAgent(auth, primaryId)
  const secondary = await readAgent(auth, secondaryId)
  if (primary && secondary && primary.id === secondary.id) {
    throw new AppError(errors.agentsMustDiffer, 400)
  }
  return { primary, secondary }
}

/**
 * Placement follows the primary agent when set; otherwise the creating user.
 * Legacy does not require a separate branch/team consistency check beyond the agent’s membership.
 *
 * @param {object} auth
 * @param {object|null} primary
 * @returns {{ branchId: string|null, teamId: string|null }}
 */
function readPlacement(auth, primary) {
  const placement = { branchId: null, teamId: null }
  if (primary) {
    placement.branchId = primary.branchId || null
    placement.teamId = primary.teamId || null
    return placement
  }
  placement.branchId = auth.user.branchId || null
  placement.teamId = auth.user.teamId || null
  return placement
}

/**
 * @param {object} body
 * @returns {{ type: string, text: string, createdAt: Date }[]}
 */
function readFeedback(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'feedback')) {
    return []
  }
  const feedback = body.feedback
  if (!feedback) {
    return []
  }
  if (typeof feedback !== 'object' || Array.isArray(feedback)) {
    throw new AppError(errors.feedbackInvalid, 400)
  }
  const text = readText(feedback, 'text')
  if (!text) {
    return []
  }
  if (!isWithinLength(text, feedbackTextLimit)) {
    throw new AppError(errors.valueTooLong, 400)
  }
  const type = readEnum(feedback, 'type', feedbackTypes, errors.feedbackTypeInvalid, feedbackTypes.general)
  return [{ type, text, createdAt: new Date() }]
}

/**
 * @param {object} body
 * @param {string} timeZone
 * @returns {Date|null}
 */
function readFollowUp(body, timeZone) {
  const value = readText(body, 'nextFollowUpAt')
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new AppError(errors.followUpInvalid, 400)
  }
  if (calendarDate(date, timeZone) < calendarDate(new Date(), timeZone)) {
    throw new AppError(errors.followUpPast, 400)
  }
  return date
}

/**
 * @param {object} auth
 * @param {object} body
 * @returns {{ text: string, createdBy: string, createdAt: Date }|null}
 */
function readNote(auth, body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'note')) {
    return null
  }
  const text = readText(body, 'note')
  if (!text) {
    throw new AppError(errors.noteRequired, 400)
  }
  if (!isWithinLength(text, feedbackTextLimit)) {
    throw new AppError(errors.valueTooLong, 400)
  }
  return { text, createdBy: auth.userId, createdAt: new Date() }
}

/**
 * @param {object} auth
 * @param {object} body
 * @param {string} timeZone
 * @returns {Promise<object|null>}
 */
async function readActivity(auth, body, timeZone) {
  const { CatalogItem } = getModels()
  if (!Object.prototype.hasOwnProperty.call(body, 'activity')) {
    return null
  }
  const activity = body.activity
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
    throw new AppError(errors.activityInvalid, 400)
  }
  const activityTypeId = readText(activity, 'activityTypeId')
  if (!activityTypeId) {
    throw new AppError(errors.activityTypeRequired, 400)
  }
  if (!isUuid(activityTypeId)) {
    throw new AppError(errors.invalidId, 400)
  }
  const activityType = await CatalogItem.findOne({
    where: {
      id: activityTypeId,
      companyId: auth.companyId,
      kind: catalogKinds.activity,
    },
  })
  if (!activityType) {
    throw new AppError(errors.catalogNotFound, 404)
  }
  if (!activityType.isActive) {
    throw new AppError(errors.activityTypeInvalid, 400)
  }
  const agentId = readText(activity, 'agentId')
  if (!agentId) {
    throw new AppError(errors.activityAgentRequired, 400)
  }
  const agent = await readAgent(auth, agentId)
  if (!agent) {
    throw new AppError(errors.activityAgentRequired, 400)
  }
  const scheduledAt = readFollowUp({ nextFollowUpAt: readText(activity, 'scheduledAt') }, timeZone)
  if (!scheduledAt) {
    throw new AppError(errors.followUpInvalid, 400)
  }
  return {
    activityTypeId: activityType.id,
    agentId: agent.id,
    scheduledAt,
    createdBy: auth.userId,
    createdAt: new Date(),
  }
}

/**
 * Validates core scalar fields shared by create (required) and edit (partial).
 *
 * @param {object} body
 * @param {{ requireCore: boolean }} options
 * @returns {object}
 */
function validateLeadScalars(body, options = { requireCore: true }) {
  const requireCore = options.requireCore !== false
  const result = {}

  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = readText(body, 'name')
    if (!name || !isWithinLength(name, security.nameMaxLength)) {
      throw new AppError(errors.nameRequired, 400)
    }
    result.name = name
  }

  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'phone')) {
    const phoneText = readText(body, 'phone')
    if (!phoneText) {
      throw new AppError(errors.phoneRequired, 400)
    }
    const phone = normalizePhone(phoneText)
    if (!isInternationalPhone(phone)) {
      throw new AppError(errors.phoneInvalid, 400)
    }
    result.phone = phone
  }

  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'email')) {
    const emailText = readText(body, 'email')
    if (!emailText) {
      result.email = ''
    } else {
      const email = normalizeEmail(emailText)
      if (!isEmail(email)) {
        throw new AppError(errors.emailInvalid, 400)
      }
      result.email = email
    }
  }

  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'source')) {
    result.source = readEnum(body, 'source', leadSources, errors.leadSourceInvalid, leadSources.manual)
  }
  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'propertyType')) {
    result.propertyType = readEnum(
      body,
      'propertyType',
      propertyTypes,
      errors.leadPropertyInvalid,
      propertyTypes.apartment,
    )
  }
  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'purpose')) {
    result.purpose = readEnum(body, 'purpose', leadPurposes, errors.leadPurposeInvalid, leadPurposes.buy)
  }
  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'readiness')) {
    result.readiness = readEnum(
      body,
      'readiness',
      readinessValues,
      errors.leadReadinessInvalid,
      readinessValues.readyToMove,
    )
  }
  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'location')) {
    result.location = readLimitedText(body, 'location')
  }
  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'budget')) {
    result.budget = readLimitedText(body, 'budget')
  }
  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'builtUpArea')) {
    result.builtUpArea = readLimitedText(body, 'builtUpArea')
  }
  if (requireCore || Object.prototype.hasOwnProperty.call(body, 'carpetArea')) {
    result.carpetArea = readLimitedText(body, 'carpetArea')
  }
  return result
}

module.exports = {
  feedbackTextLimit,
  textLimit,
  maxTagIds,
  readEnum,
  readLimitedText,
  readStatus,
  readTags,
  readAgent,
  readAgents,
  readPlacement,
  readFeedback,
  readFollowUp,
  readNote,
  readActivity,
  validateLeadScalars,
}
