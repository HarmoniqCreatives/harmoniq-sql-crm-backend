const { getModels } = require('../models')
const { userStatuses } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { isUuid, readText } = require('../utils/helpers')

/**
 * Company-level Meta Lead Ads default assignee.
 * Stored on Company; resolved during Meta import (webhook + sync share processIngestion).
 */

/**
 * @param {object|null} user
 * @returns {{ id: string, name: string, email: string }|null}
 */
function presentAssignee(user) {
  if (!user) {
    return null
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  }
}

/**
 * Lists active users in the caller's company for the assignee picker.
 * @param {string} companyId
 * @returns {Promise<object[]>}
 */
async function listActiveCompanyAgents(companyId) {
  const { User } = getModels()
  const users = await User.findAll({
    where: {
      companyId,
      status: userStatuses.active,
    },
    attributes: ['id', 'name', 'email'],
    order: [['name', 'ASC']],
  })
  return users.map((row) => presentAssignee(row))
}

/**
 * @param {object} auth
 * @returns {Promise<{ assignee: object|null, agents: object[] }>}
 */
async function getMetaDefaultAssignee(auth) {
  const { Company, User } = getModels()
  const company = await Company.findByPk(auth.companyId, {
    attributes: ['id', 'metaDefaultAssigneeUserId'],
  })
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  const agents = await listActiveCompanyAgents(auth.companyId)
  let assignee = null
  if (company.metaDefaultAssigneeUserId) {
    const user = await User.findOne({
      where: {
        id: company.metaDefaultAssigneeUserId,
        companyId: auth.companyId,
        status: userStatuses.active,
      },
      attributes: ['id', 'name', 'email'],
    })
    assignee = presentAssignee(user)
  }
  return { assignee, agents }
}

/**
 * Sets or clears the Meta default assignee for the authenticated company.
 * @param {object} auth
 * @param {object} body `{ userId: string|null }` — empty/null clears
 * @returns {Promise<{ assignee: object|null, agents: object[] }>}
 */
async function updateMetaDefaultAssignee(auth, body) {
  const { Company, User } = getModels()
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }

  const hasUserId = Object.prototype.hasOwnProperty.call(body || {}, 'userId')
  if (!hasUserId) {
    throw new AppError(errors.metaDefaultAssigneeRequired, 400)
  }

  const raw = body.userId
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    company.metaDefaultAssigneeUserId = null
    await company.save()
    const agents = await listActiveCompanyAgents(auth.companyId)
    return { assignee: null, agents }
  }

  const userId = readText(body, 'userId')
  if (!isUuid(userId)) {
    throw new AppError(errors.invalidId, 400)
  }
  const user = await User.findOne({
    where: {
      id: userId,
      companyId: auth.companyId,
      status: userStatuses.active,
    },
    attributes: ['id', 'name', 'email'],
  })
  if (!user) {
    throw new AppError(errors.agentNotFound, 404)
  }

  company.metaDefaultAssigneeUserId = user.id
  await company.save()
  const agents = await listActiveCompanyAgents(auth.companyId)
  return { assignee: presentAssignee(user), agents }
}

/**
 * Resolves a safe primaryAgentId for Meta import. Never returns a cross-tenant or inactive user.
 * @param {string} companyId
 * @returns {Promise<string|null>}
 */
async function resolveMetaDefaultPrimaryAgentId(companyId) {
  const { Company, User } = getModels()
  const company = await Company.findByPk(companyId, {
    attributes: ['id', 'metaDefaultAssigneeUserId'],
  })
  if (!company || !company.metaDefaultAssigneeUserId) {
    return null
  }
  const user = await User.findOne({
    where: {
      id: company.metaDefaultAssigneeUserId,
      companyId,
      status: userStatuses.active,
    },
    attributes: ['id'],
  })
  if (!user) {
    console.warn(JSON.stringify({
      event: 'meta_default_assignee_invalid',
      companyId: String(companyId),
      userId: String(company.metaDefaultAssigneeUserId),
      message: 'Configured Meta default assignee is missing or inactive; importing unassigned.',
    }))
    return null
  }
  return user.id
}

module.exports = {
  getMetaDefaultAssignee,
  updateMetaDefaultAssignee,
  resolveMetaDefaultPrimaryAgentId,
  listActiveCompanyAgents,
  presentAssignee,
}
