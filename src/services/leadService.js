const { v4: uuidv4 } = require('uuid')
const { Op } = require('sequelize')
const { getModels } = require('../models')
const { allocateLeadNumber } = require('./leadCounter')
const { calendarDate, isOverdue } = require('./leadOverdue')
const { presentLead } = require('../modules/leads/leadPresenter')
const {
  readActivity,
  readAgents,
  readAgent,
  readFeedback,
  readFollowUp,
  readLimitedText,
  readNote,
  readPlacement,
  readStatus,
  readTags,
  validateLeadScalars,
} = require('../modules/leads/leadValidators')
const {
  leadSorts,
  leadSources,
  roleScopes,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const { isUuid, readText } = require('../utils/helpers')

/**
 * Lead CRUD, scope, assignment, notes/feedback/activities — legacy leadService parity.
 * companyId always from auth; soft-deleted leads excluded by Sequelize paranoid.
 */

/**
 * Builds the tenant + role scope filter. OWN includes primary OR secondary agent.
 *
 * @param {object} auth
 * @returns {object} Sequelize where fragment (may include Op.or)
 */
function leadScopeFilter(auth) {
  const filter = { companyId: auth.companyId }
  if (auth.role?.isProtected) {
    return filter
  }
  if (auth.role?.scope === roleScopes.company) {
    return filter
  }
  if (auth.role?.scope === roleScopes.branch) {
    filter.branchId = auth.user.branchId || null
    return filter
  }
  if (auth.role?.scope === roleScopes.team) {
    if (!auth.user.teamId) {
      filter.id = null
      return filter
    }
    filter.teamId = auth.user.teamId
    return filter
  }
  filter[Op.or] = [
    { primaryAgentId: auth.userId },
    { secondaryAgentId: auth.userId },
  ]
  return filter
}

/**
 * @param {object} auth
 * @param {object} query
 * @returns {Promise<{ where: object, include: object[] }>}
 */
async function buildLeadQuery(auth, query) {
  const filter = leadScopeFilter(auth)
  const and = []
  if (filter[Op.or]) {
    and.push({ [Op.or]: filter[Op.or] })
    delete filter[Op.or]
  }

  const search = readText(query, 'search')
  if (search) {
    const like = `%${search.replace(/[%_]/g, '\\$&')}%`
    const matches = [
      { name: { [Op.like]: like } },
      { phone: { [Op.like]: like } },
      { email: { [Op.like]: like } },
    ]
    const digits = search.replace('#', '')
    const asNumber = Number(digits)
    if (Number.isInteger(asNumber) && String(asNumber) === digits) {
      matches.push({ number: asNumber })
    }
    and.push({ [Op.or]: matches })
  }

  const statusId = readOptionalId(query, 'statusId')
  if (statusId) {
    filter.statusId = statusId
  }
  const branchId = readOptionalId(query, 'branchId')
  if (branchId) {
    if (filter.branchId && String(filter.branchId) !== branchId) {
      filter.id = null
    } else {
      filter.branchId = branchId
    }
  }
  const teamId = readOptionalId(query, 'teamId')
  if (teamId) {
    if (filter.teamId && String(filter.teamId) !== teamId) {
      filter.id = null
    } else {
      filter.teamId = teamId
    }
  }
  const agentId = readOptionalId(query, 'agentId')
  if (agentId) {
    and.push({
      [Op.or]: [
        { primaryAgentId: agentId },
        { secondaryAgentId: agentId },
      ],
    })
  }
  const source = readText(query, 'source')
  if (source) {
    if (!Object.values(leadSources).includes(source)) {
      throw new AppError(errors.leadSourceInvalid, 400)
    }
    filter.source = source
  }

  const include = [
    { association: 'tagRows', required: false },
    { association: 'notes', required: false },
    { association: 'feedbacks', required: false },
    { association: 'transfers', required: false },
    { association: 'activities', required: false },
  ]

  const tagId = readOptionalId(query, 'tagId')
  if (tagId) {
    include[0] = {
      association: 'tagRows',
      required: true,
      where: { tagId },
    }
  }

  if (and.length > 0) {
    filter[Op.and] = and
  }
  return { where: filter, include }
}

function readPageNumber(value, fallback, max) {
  const number = Number(value)
  if (!number || number < 1) {
    return fallback
  }
  return Math.min(Math.floor(number), max)
}

function readSort(query) {
  let field = leadSorts.createdAt
  const requested = readText(query, 'sort')
  if (requested) {
    if (!Object.values(leadSorts).includes(requested)) {
      throw new AppError(errors.sortInvalid, 400)
    }
    field = requested
  }
  const direction = readText(query, 'order') === 'asc' ? 'ASC' : 'DESC'
  return [[field, direction]]
}

function readOptionalId(query, fieldName) {
  const value = readText(query, fieldName)
  if (!value) {
    return ''
  }
  if (!isUuid(value)) {
    throw new AppError(errors.invalidId, 400)
  }
  return value
}

/**
 * @param {object} auth
 * @param {object} query
 * @returns {Promise<{ leads: object[], page: number, limit: number, total: number }>}
 */
async function listLeads(auth, query) {
  const { Lead } = getModels()
  const { where, include } = await buildLeadQuery(auth, query)
  const page = readPageNumber(query.page, 1, 10000)
  const limit = readPageNumber(query.limit, 20, 50)
  const order = readSort(query)
  const { rows, count } = await Lead.findAndCountAll({
    where,
    include,
    order,
    offset: (page - 1) * limit,
    limit,
    distinct: true,
  })
  const leads = await presentLeads(auth, rows)
  return { leads, page, limit, total: count }
}

/**
 * @param {object} auth
 * @param {string} leadId
 * @returns {Promise<{ lead: object }>}
 */
async function getLead(auth, leadId) {
  const lead = await findLeadInScope(auth, leadId)
  const [row] = await presentLeads(auth, [lead])
  return { lead: row }
}

/**
 * @param {object} auth
 * @param {object} body
 * @returns {Promise<{ message: string, lead: object }>}
 */
async function createLead(auth, body) {
  const { sequelize, Lead, LeadTag, LeadFeedback, Company } = getModels()
  const scalars = validateLeadScalars(body, { requireCore: true })
  const status = await readStatus(auth, body)
  const tags = await readTags(auth, body)
  const agents = await readAgents(auth, body)
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  const placement = readPlacement(auth, agents.primary)
  const nextFollowUpAt = readFollowUp(body, company.timezone)
  const feedbacks = readFeedback(body)
  const metaLeadId = readText(body, 'metaLeadId') || null
  const campaignId = readText(body, 'campaignId')
  const campaignName = readText(body, 'campaignName')

  try {
    const lead = await createLeadWithRetry({
      sequelize,
      Lead,
      LeadTag,
      LeadFeedback,
      auth,
      scalars,
      status,
      tags,
      agents,
      placement,
      metaLeadId,
      campaignId,
      campaignName,
      company,
      nextFollowUpAt,
      feedbacks,
    })
    const full = await findLeadInScope(auth, lead.id)
    const [row] = await presentLeads(auth, [full])
    return { message: messages.leadCreated, lead: row }
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      const fields = error.fields || {}
      if (fields.metaLeadId || fields.companyId_metaLeadId || String(error.message || '').includes('meta')) {
        throw new AppError(errors.metaLeadDuplicate, 409)
      }
      throw new AppError(errors.leadNumberConflict, 409)
    }
    throw error
  }
}

async function createLeadWithRetry(context, attempt = 0) {
  const {
    sequelize,
    Lead,
    LeadTag,
    LeadFeedback,
    auth,
    scalars,
    status,
    tags,
    agents,
    placement,
    metaLeadId,
    campaignId,
    campaignName,
    company,
    nextFollowUpAt,
    feedbacks,
  } = context
  try {
    return await sequelize.transaction(async (transaction) => {
      const number = await allocateLeadNumber(auth.companyId, transaction)
      const created = await Lead.create({
        id: uuidv4(),
        companyId: auth.companyId,
        number,
        name: scalars.name,
        phone: scalars.phone,
        email: scalars.email,
        source: scalars.source,
        metaLeadId,
        campaignId: campaignId || '',
        campaignName: campaignName || '',
        statusId: status.id,
        primaryAgentId: agents.primary ? agents.primary.id : null,
        secondaryAgentId: agents.secondary ? agents.secondary.id : null,
        branchId: placement.branchId,
        teamId: placement.teamId,
        propertyType: scalars.propertyType,
        purpose: scalars.purpose,
        location: scalars.location,
        budget: scalars.budget,
        currency: company.baseCurrency,
        builtUpArea: scalars.builtUpArea,
        carpetArea: scalars.carpetArea,
        readiness: scalars.readiness,
        nextFollowUpAt,
      }, { transaction })

      for (const tag of tags) {
        await LeadTag.create({
          id: uuidv4(),
          companyId: auth.companyId,
          leadId: created.id,
          tagId: tag.id,
        }, { transaction })
      }
      for (const feedback of feedbacks) {
        await LeadFeedback.create({
          id: uuidv4(),
          companyId: auth.companyId,
          leadId: created.id,
          type: feedback.type,
          text: feedback.text,
          createdAt: feedback.createdAt,
          updatedAt: feedback.createdAt,
        }, { transaction })
      }
      return created
    })
  } catch (error) {
    const deadlocked = String(error.message || '').toLowerCase().includes('deadlock')
    if (deadlocked && attempt < 3) {
      return createLeadWithRetry(context, attempt + 1)
    }
    throw error
  }
}

/**
 * @param {object} auth
 * @param {string} leadId
 * @param {object} body
 * @returns {Promise<{ message: string, lead: object }>}
 */
async function updateLead(auth, leadId, body) {
  const { sequelize, LeadTag, LeadFeedback, LeadNote, LeadActivity, Company } = getModels()
  const lead = await findLeadInScope(auth, leadId)
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }

  const scalars = validateLeadScalars(body, { requireCore: false })
  Object.assign(lead, scalars)

  if (Object.prototype.hasOwnProperty.call(body, 'statusId')) {
    const status = await readStatus(auth, body)
    lead.statusId = status.id
  }
  if (Object.prototype.hasOwnProperty.call(body, 'nextFollowUpAt')) {
    lead.nextFollowUpAt = readFollowUp(body, company.timezone)
  }

  await sequelize.transaction(async (transaction) => {
    if (Object.prototype.hasOwnProperty.call(body, 'tagIds')) {
      const tags = await readTags(auth, body)
      await LeadTag.destroy({ where: { leadId: lead.id }, transaction })
      for (const tag of tags) {
        await LeadTag.create({
          id: uuidv4(),
          companyId: auth.companyId,
          leadId: lead.id,
          tagId: tag.id,
        }, { transaction })
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'feedback')) {
      const feedbackNotes = readFeedback(body)
      for (const feedback of feedbackNotes) {
        await LeadFeedback.create({
          id: uuidv4(),
          companyId: auth.companyId,
          leadId: lead.id,
          type: feedback.type,
          text: feedback.text,
          createdAt: feedback.createdAt,
          updatedAt: feedback.createdAt,
        }, { transaction })
      }
    }

    const note = readNote(auth, body)
    if (note) {
      await LeadNote.create({
        id: uuidv4(),
        companyId: auth.companyId,
        leadId: lead.id,
        text: note.text,
        createdBy: note.createdBy,
        createdAt: note.createdAt,
        updatedAt: note.createdAt,
      }, { transaction })
    }

    const activity = await readActivity(auth, body, company.timezone)
    if (activity) {
      await LeadActivity.create({
        id: uuidv4(),
        companyId: auth.companyId,
        leadId: lead.id,
        activityTypeId: activity.activityTypeId,
        agentId: activity.agentId,
        scheduledAt: activity.scheduledAt,
        createdBy: activity.createdBy,
        createdAt: activity.createdAt,
        updatedAt: activity.createdAt,
      }, { transaction })
      lead.nextFollowUpAt = activity.scheduledAt
    }

    await lead.save({ transaction })
  })

  const full = await findLeadInScope(auth, lead.id)
  const [row] = await presentLeads(auth, [full])
  return { message: messages.leadUpdated, lead: row }
}

/**
 * @param {object} auth
 * @param {string} leadId
 * @param {object} body
 * @returns {Promise<{ message: string, lead: object }>}
 */
async function assignLead(auth, leadId, body) {
  const { sequelize, LeadTransfer } = getModels()
  const lead = await findLeadInScope(auth, leadId)
  const reason = readLimitedText(body, 'reason')
  if (!reason) {
    throw new AppError(errors.transferReasonRequired, 400)
  }
  const primaryId = readText(body, 'primaryAgentId')
  if (!primaryId) {
    throw new AppError(errors.primaryAgentRequired, 400)
  }
  const primary = await readAgent(auth, primaryId)
  let secondary = null
  if (Object.prototype.hasOwnProperty.call(body, 'secondaryAgentId')) {
    secondary = await readAgent(auth, readText(body, 'secondaryAgentId'))
  } else if (lead.secondaryAgentId) {
    secondary = await readAgent(auth, String(lead.secondaryAgentId))
  }
  if (secondary && primary.id === secondary.id) {
    throw new AppError(errors.agentsMustDiffer, 400)
  }
  const placement = readPlacement(auth, primary)
  const previousPrimaryAgentId = lead.primaryAgentId

  await sequelize.transaction(async (transaction) => {
    await LeadTransfer.create({
      id: uuidv4(),
      companyId: auth.companyId,
      leadId: lead.id,
      previousPrimaryAgentId: previousPrimaryAgentId || null,
      primaryAgentId: primary.id,
      secondaryAgentId: secondary ? secondary.id : null,
      reason,
      transferredBy: auth.userId,
    }, { transaction })
    lead.primaryAgentId = primary.id
    lead.secondaryAgentId = secondary ? secondary.id : null
    lead.branchId = placement.branchId
    lead.teamId = placement.teamId
    await lead.save({ transaction })
  })

  const full = await findLeadInScope(auth, lead.id)
  const [row] = await presentLeads(auth, [full])
  return { message: messages.leadAssigned, lead: row }
}

/**
 * Soft-deletes a lead. Number remains reserved.
 *
 * @param {object} auth
 * @param {string} leadId
 * @returns {Promise<{ message: string }>}
 */
async function deleteLead(auth, leadId) {
  const { sequelize } = getModels()
  const lead = await findLeadInScope(auth, leadId)
  await sequelize.transaction(async (transaction) => {
    lead.deletedBy = auth.userId
    await lead.save({ transaction })
    await lead.destroy({ transaction })
  })
  return { message: messages.leadDeleted }
}

async function findLeadInScope(auth, leadId) {
  const { Lead } = getModels()
  if (!isUuid(leadId)) {
    throw new AppError(errors.invalidId, 400)
  }
  const filter = leadScopeFilter(auth)
  if (filter.id === null) {
    throw new AppError(errors.leadNotFound, 404)
  }
  filter.id = leadId
  const lead = await Lead.findOne({
    where: filter,
    include: [
      { association: 'tagRows', required: false },
      { association: 'notes', required: false },
      { association: 'feedbacks', required: false },
      { association: 'transfers', required: false },
      { association: 'activities', required: false },
    ],
  })
  if (!lead) {
    throw new AppError(errors.leadNotFound, 404)
  }
  return lead
}

async function presentLeads(auth, leads) {
  const { CatalogItem, User, Company } = getModels()
  const [items, users, company] = await Promise.all([
    CatalogItem.findAll({ where: { companyId: auth.companyId } }),
    User.findAll({ where: { companyId: auth.companyId } }),
    Company.findByPk(auth.companyId),
  ])
  const itemMap = new Map(items.map((item) => [item.id, item]))
  const userMap = new Map(users.map((user) => [user.id, user]))
  const timeZone = company ? company.timezone : ''
  return leads.map((lead) => presentLead(lead, itemMap, userMap, timeZone))
}

module.exports = {
  listLeads,
  getLead,
  createLead,
  updateLead,
  assignLead,
  deleteLead,
  leadScopeFilter,
  presentLead,
  isOverdue,
  calendarDate,
}
