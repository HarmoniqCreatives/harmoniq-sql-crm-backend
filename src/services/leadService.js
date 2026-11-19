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
  whatsappWorkflowKeys,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const { isUuid, readText } = require('../utils/helpers')
const assignmentNotifications = require('./assignmentNotificationService')
const whatsappAssignmentNotifications = require('./whatsappAssignmentNotificationService')

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

  // Facebook Page filter (exact page name; blank/unknown uses the shared Unknown_Page_Type token).
  const pageType = readText(query, 'pageType')
  if (pageType) {
    if (pageType === messages.dailyLeadEmailUnknownPageType) {
      and.push({
        [Op.or]: [
          { facebookPageName: '' },
          { facebookPageName: null },
        ],
      })
    } else {
      filter.facebookPageName = pageType
    }
  }

  appendLeadDateRangeFilter(and, query)

  if (and.length > 0) {
    filter[Op.and] = and
  }
  return { where: filter, include }
}

/**
 * Parses YYYY-MM-DD (or ISO) into a Date boundary.
 * @param {unknown} value
 * @param {{ endOfDay?: boolean }} options
 * @returns {Date|null}
 */
function readLeadDateBoundary(value, { endOfDay = false } = {}) {
  const text = String(value || '').trim()
  if (!text) {
    return null
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) {
    throw new AppError(errors.reportDateRangeInvalid, 400)
  }
  return date
}

/**
 * Meta leads (non-empty metaLeadId) filter on metaCreatedAt.
 * Manual / non-Meta leads filter on CRM createdAt.
 * @param {object[]} and
 * @param {object} query
 */
function appendLeadDateRangeFilter(and, query) {
  const start = readLeadDateBoundary(query.startDate || query.from, { endOfDay: false })
  const end = readLeadDateBoundary(query.endDate || query.to, { endOfDay: true })
  if ((start && !end) || (!start && end)) {
    throw new AppError(errors.reportDateRangeInvalid, 400)
  }
  if (start && end && start.getTime() > end.getTime()) {
    throw new AppError(errors.reportDateRangeInvalid, 400)
  }
  if (!start || !end) {
    return
  }
  and.push({
    [Op.or]: [
      {
        [Op.and]: [
          { metaLeadId: { [Op.ne]: null } },
          { metaLeadId: { [Op.ne]: '' } },
          { metaCreatedAt: { [Op.between]: [start, end] } },
        ],
      },
      {
        [Op.and]: [
          {
            [Op.or]: [
              { metaLeadId: null },
              { metaLeadId: '' },
            ],
          },
          { createdAt: { [Op.between]: [start, end] } },
        ],
      },
    ],
  })
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
  const campaignStatus = readText(body, 'campaignStatus')
  const facebookPageId = readText(body, 'facebookPageId')
  const facebookPageName = readText(body, 'facebookPageName')
  let metaCreatedAt = null
  if (body && body.metaCreatedAt) {
    const parsed = body.metaCreatedAt instanceof Date
      ? body.metaCreatedAt
      : new Date(body.metaCreatedAt)
    if (!Number.isNaN(parsed.getTime())) {
      metaCreatedAt = parsed
    }
  }

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
      metaCreatedAt,
      campaignId,
      campaignName,
      campaignStatus,
      facebookPageId,
      facebookPageName,
      company,
      nextFollowUpAt,
      feedbacks,
    })
    if (lead.primaryAgentId) {
      let assignedByName = ''
      if (auth.user && auth.user.name) {
        assignedByName = auth.user.name
      }
      if (metaLeadId || scalars.source === leadSources.facebook) {
        assignedByName = assignmentNotifications.META_ASSIGNED_BY
      }
      try {
        assignmentNotifications.notifyLeadPrimaryAssignment({
          companyId: auth.companyId,
          leadId: lead.id,
          previousPrimaryAgentId: null,
          newPrimaryAgentId: lead.primaryAgentId,
          assignedByName,
          contactName: lead.name,
          contactNumber: lead.phone,
          emailKind: assignmentNotifications.EMAIL_KINDS.newLead,
        })
      } catch (_error) {
        // Lead already created; New Lead email must never fail this request.
      }
      try {
        await whatsappAssignmentNotifications.notifyLeadPrimaryWhatsApp({
          companyId: auth.companyId,
          leadId: lead.id,
          previousPrimaryAgentId: null,
          newPrimaryAgentId: lead.primaryAgentId,
          actorUserId: auth.userId,
          contactName: lead.name,
          contactNumber: lead.phone,
          campaignName: lead.campaignName || '',
          facebookPageName: lead.facebookPageName || '',
          workflowKey: whatsappWorkflowKeys.metaAssign,
          emailKind: assignmentNotifications.EMAIL_KINDS.newLead,
          idempotencyKey: whatsappAssignmentNotifications.buildMetaAssignIdempotencyKey({
            companyId: auth.companyId,
            leadId: lead.id,
            primaryAgentId: lead.primaryAgentId,
          }),
        })
      } catch (_error) {
        // Lead already created; WhatsApp W1 must never fail this request.
      }
    }
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
    metaCreatedAt,
    campaignId,
    campaignName,
    campaignStatus,
    facebookPageId,
    facebookPageName,
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
        metaCreatedAt: metaCreatedAt || null,
        campaignId: campaignId || '',
        campaignName: campaignName || '',
        campaignStatus: campaignStatus || '',
        facebookPageId: facebookPageId || '',
        facebookPageName: facebookPageName || '',
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
  // Transfer reason is optional; empty string matches allowNull:false on lead_transfers.reason.
  let reason = ''
  if (Object.prototype.hasOwnProperty.call(body || {}, 'reason')) {
    reason = readLimitedText(body, 'reason')
  }
  const primaryId = readText(body, 'primaryAgentId')
  if (!primaryId) {
    throw new AppError(errors.primaryAgentRequired, 400)
  }
  const primary = await readAgent(auth, primaryId)
  if (lead.primaryAgentId && String(lead.primaryAgentId) === String(primary.id)) {
    throw new AppError(errors.transferSameAgent, 400)
  }
  // Transfer UI only changes primary. Preserve secondary unless it would equal the new primary.
  let secondary = null
  if (lead.secondaryAgentId && String(lead.secondaryAgentId) !== String(primary.id)) {
    secondary = await readAgent(auth, String(lead.secondaryAgentId))
  }
  const placement = readPlacement(auth, primary)
  const previousPrimaryAgentId = lead.primaryAgentId
  const isFirstPrimaryAssign = !previousPrimaryAgentId

  let previousAgentName = ''
  if (previousPrimaryAgentId) {
    try {
      const previousAgent = await readAgent(auth, String(previousPrimaryAgentId))
      if (previousAgent && previousAgent.name) {
        previousAgentName = previousAgent.name
      }
    } catch (_error) {
      previousAgentName = ''
    }
  }

  const transferId = uuidv4()
  const secondaryId = secondary ? secondary.id : null
  await sequelize.transaction(async (transaction) => {
    await LeadTransfer.create({
      id: transferId,
      companyId: auth.companyId,
      leadId: lead.id,
      previousPrimaryAgentId: previousPrimaryAgentId || null,
      primaryAgentId: primary.id,
      secondaryAgentId: secondaryId,
      reason,
      transferredBy: auth.userId,
    }, { transaction })
    lead.primaryAgentId = primary.id
    lead.secondaryAgentId = secondaryId
    lead.branchId = placement.branchId
    lead.teamId = placement.teamId
    await lead.save({ transaction })
  })

  let assignerName = ''
  if (auth.user && auth.user.name) {
    assignerName = auth.user.name
  }
  try {
    // assignLead is the transfer API: email only for A→B (shouldNotifyTransfer).
    // null→A must not send a new_lead email (that belongs to createLead / Meta create).
    assignmentNotifications.notifyLeadPrimaryAssignment({
      companyId: auth.companyId,
      leadId: lead.id,
      previousPrimaryAgentId,
      newPrimaryAgentId: primary.id,
      assignedByName: assignerName,
      contactName: lead.name,
      contactNumber: lead.phone,
      transferReason: reason,
      previousAgentName,
      emailKind: assignmentNotifications.EMAIL_KINDS.transfer,
    })
  } catch (_error) {
    // Assignment already saved; notification must never fail this request.
  }
  // WhatsApp only after the assignment transaction committed.
  // First primary assign (null → A) via Transfer uses W1; A → B uses W2.
  try {
    if (isFirstPrimaryAssign) {
      await whatsappAssignmentNotifications.notifyLeadPrimaryWhatsApp({
        companyId: auth.companyId,
        leadId: lead.id,
        previousPrimaryAgentId: null,
        newPrimaryAgentId: primary.id,
        actorUserId: auth.userId,
        contactName: lead.name,
        contactNumber: lead.phone,
        campaignName: lead.campaignName || '',
        facebookPageName: lead.facebookPageName || '',
        workflowKey: whatsappWorkflowKeys.metaAssign,
        emailKind: assignmentNotifications.EMAIL_KINDS.newLead,
        idempotencyKey: whatsappAssignmentNotifications.buildMetaAssignIdempotencyKey({
          companyId: auth.companyId,
          leadId: lead.id,
          primaryAgentId: primary.id,
        }),
      })
    } else {
      await whatsappAssignmentNotifications.notifyLeadPrimaryWhatsApp({
        companyId: auth.companyId,
        leadId: lead.id,
        previousPrimaryAgentId,
        newPrimaryAgentId: primary.id,
        transferId,
        actorUserId: auth.userId,
        contactName: lead.name,
        contactNumber: lead.phone,
        campaignName: lead.campaignName || '',
        facebookPageName: lead.facebookPageName || '',
        workflowKey: whatsappWorkflowKeys.transfer,
        emailKind: assignmentNotifications.EMAIL_KINDS.transfer,
        idempotencyKey: whatsappAssignmentNotifications.buildTransferIdempotencyKey({
          companyId: auth.companyId,
          leadId: lead.id,
          transferId,
          primaryAgentId: primary.id,
        }),
      })
    }
  } catch (_error) {
    // Assignment already saved; WhatsApp must never fail this request.
  }

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


const BULK_LEAD_LIMIT = 100

/**
 * @param {unknown} body
 * @returns {string[]}
 */
function readBulkLeadIds(body) {
  const raw = body && body.ids
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(errors.bulkIdsRequired, 400)
  }
  if (raw.length > BULK_LEAD_LIMIT) {
    throw new AppError(errors.bulkIdsLimit, 400)
  }
  const ids = []
  const seen = new Set()
  for (const value of raw) {
    const id = String(value || '').trim()
    if (!id || !isUuid(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (!ids.length) {
    throw new AppError(errors.bulkIdsRequired, 400)
  }
  return ids
}

/**
 * Runs per-lead work with scope isolation; returns success/failure lists.
 * @param {object} auth
 * @param {string[]} ids
 * @param {(leadId: string) => Promise<void>} worker
 */
async function runBulkLeadAction(auth, ids, worker) {
  const succeeded = []
  const failed = []
  for (const leadId of ids) {
    try {
      await worker(leadId)
      succeeded.push(leadId)
    } catch (error) {
      failed.push({
        id: leadId,
        message: error && error.message ? error.message : errors.requestFailed,
        status: error && error.status ? error.status : 500,
      })
    }
  }
  return { succeeded, failed, succeededCount: succeeded.length, failedCount: failed.length }
}

/**
 * Bulk assign / first-assign (same rules as assignLead).
 */
async function bulkAssignLeads(auth, body) {
  const ids = readBulkLeadIds(body)
  const result = await runBulkLeadAction(auth, ids, async (leadId) => {
    await assignLead(auth, leadId, {
      primaryAgentId: body.primaryAgentId,
      reason: body.reason,
    })
  })
  return { message: messages.leadsBulkAssignDone, ...result }
}

/**
 * Bulk transfer (same assignLead path; optional reason preserved).
 */
async function bulkTransferLeads(auth, body) {
  const ids = readBulkLeadIds(body)
  const result = await runBulkLeadAction(auth, ids, async (leadId) => {
    await assignLead(auth, leadId, {
      primaryAgentId: body.primaryAgentId,
      reason: body.reason,
    })
  })
  return { message: messages.leadsBulkTransferDone, ...result }
}

/**
 * Bulk soft-delete.
 */
async function bulkDeleteLeads(auth, body) {
  const ids = readBulkLeadIds(body)
  const result = await runBulkLeadAction(auth, ids, async (leadId) => {
    await deleteLead(auth, leadId)
  })
  return { message: messages.leadsBulkDeleteDone, ...result }
}

module.exports = {
  listLeads,
  getLead,
  createLead,
  updateLead,
  assignLead,
  deleteLead,
  bulkAssignLeads,
  bulkTransferLeads,
  bulkDeleteLeads,
  leadScopeFilter,
  buildLeadQuery,
  presentLeads,
  presentLead,
  isOverdue,
  calendarDate,
  readLeadDateBoundary,
  appendLeadDateRangeFilter,
}
