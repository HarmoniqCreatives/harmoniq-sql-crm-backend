const crypto = require('crypto')
const os = require('os')
const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { security } = require('../config/security')
const { getModels } = require('../models')
const {
  catalogKinds,
  leadSources,
  metaConnectionStatuses,
  metaPageStatuses,
  metaSyncJobStatuses,
  metaWebhookIngestionStatuses,
  roleKeys,
  userStatuses,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  isInternationalPhone,
  isUuid,
  normalizePhone,
  readText,
} = require('../utils/helpers')
const { decryptSecret } = require('../utils/metaSecrets')
const graphClient = require('./metaGraph')
const { createLead } = require('./leadService')

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`

let syncJobsRunning = false
let syncWorkerTimer = null
let ingestionWorkerTimer = null

function presentSyncJob(job) {
  let message = messages.metaSyncAccepted
  if (job.status === metaSyncJobStatuses.completed) {
    message = messages.metaLeadsSynced
  }
  if (job.status === metaSyncJobStatuses.failed) {
    message = job.errorMessage || errors.metaSyncFailed
  }
  return {
    id: job.id,
    metaPageId: job.metaPageId,
    facebookPageId: job.facebookPageId,
    status: job.status,
    imported: job.imported,
    skipped: job.skipped,
    failed: job.failed,
    pending: job.pending,
    formsTotal: job.formsTotal,
    formsDone: job.formsDone,
    leadsSeen: job.leadsSeen,
    errorMessage: job.errorMessage || '',
    message,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  }
}

function syncJobsAutoRunEnabled() {
  return process.env.META_SYNC_AUTORUN !== '0'
}

function nextAttemptDate(retryCount) {
  let seconds = 2 ** retryCount
  if (seconds > 300) seconds = 300
  return new Date(Date.now() + seconds * 1000)
}

function readField(fieldData, names) {
  if (!Array.isArray(fieldData)) return ''
  for (const field of fieldData) {
    if (!field) continue
    const key = field.name ? String(field.name).toLowerCase() : ''
    if (!names.includes(key)) continue
    if (Array.isArray(field.values) && field.values[0]) {
      return String(field.values[0]).trim()
    }
  }
  return ''
}

function mapLeadFields(graphLead) {
  const fieldData = graphLead.field_data
  let name = readField(fieldData, ['full_name', 'full name'])
  if (!name) {
    const first = readField(fieldData, ['first_name', 'first name'])
    const last = readField(fieldData, ['last_name', 'last name'])
    name = `${first} ${last}`.trim()
  }
  const phone = normalizePhone(readField(fieldData, ['phone_number', 'phone', 'mobile_number', 'mobile']))
  const email = readField(fieldData, ['email'])
  return {
    name,
    phone,
    email,
    formId: graphLead.form_id ? String(graphLead.form_id) : '',
    campaignId: graphLead.campaign_id ? String(graphLead.campaign_id) : '',
    adSetId: graphLead.adset_id ? String(graphLead.adset_id) : '',
    adId: graphLead.ad_id ? String(graphLead.ad_id) : '',
  }
}

function buildMetaLeadNote(details) {
  const lines = [messages.metaLeadAutoImportedNote]
  if (details.pageName) lines.push(`${messages.metaLeadNotePage}: ${details.pageName}`)
  if (details.formName) lines.push(`${messages.metaLeadNoteForm}: ${details.formName}`)
  else if (details.formId) lines.push(`${messages.metaLeadNoteForm}: ${details.formId}`)
  if (details.leadgenId) lines.push(`${messages.metaLeadNoteLeadId}: ${details.leadgenId}`)
  if (details.campaignName) lines.push(`${messages.metaLeadNoteCampaign}: ${details.campaignName}`)
  if (details.adSetName) lines.push(`${messages.metaLeadNoteAdSet}: ${details.adSetName}`)
  if (details.adName) lines.push(`${messages.metaLeadNoteAd}: ${details.adName}`)
  if (details.facebookCreatedAt) {
    lines.push(`${messages.metaLeadNoteCreated}: ${details.facebookCreatedAt.toISOString()}`)
  }
  lines.push(`${messages.metaLeadNoteSource}: ${messages.metaLeadNoteSourceFacebook}`)
  return lines.join('\n')
}

function leadIsBefore(graphLead, since) {
  if (!since || !graphLead.created_time) return false
  const created = new Date(graphLead.created_time)
  if (Number.isNaN(created.getTime())) return false
  return created.getTime() < since.getTime()
}

function makeDedupeKey(companyId, pageId, leadgenId) {
  return `${companyId}:${pageId}:${leadgenId}`
}

async function companyActor(companyId) {
  const { User, Role, Company } = getModels()
  const company = await Company.findByPk(companyId)
  const role = await Role.findOne({
    where: { companyId, key: roleKeys.superAdmin, isProtected: true },
  })
  const user = await User.findOne({
    where: {
      companyId,
      isInitialSuperAdmin: true,
      status: userStatuses.active,
    },
  })
  if (!company || !role || !user) {
    throw new AppError(errors.roleNotFound, 500)
  }
  return {
    userId: user.id,
    companyId,
    roleId: role.id,
    user,
    role,
    company,
  }
}

async function markPageTokenExpired(page) {
  const { MetaPage, MetaConnection } = getModels()
  await MetaPage.update(
    {
      status: metaPageStatuses.expired,
      lastError: errors.metaTokenExpired,
      webhookSubscribed: false,
      tokenCipher: null,
    },
    { where: { id: page.id } },
  )
  await MetaConnection.update(
    { status: metaConnectionStatuses.expired },
    { where: { id: page.connectionId } },
  )
}

async function loadConnectedPageForSync(auth, pageId) {
  const { MetaPage } = getModels()
  if (!isUuid(pageId)) {
    throw new AppError(errors.metaPageNotFound, 404)
  }
  const page = await MetaPage.findOne({
    where: {
      id: pageId,
      companyId: auth.companyId,
      status: metaPageStatuses.connected,
    },
  })
  if (!page) {
    throw new AppError(errors.metaPageNotFound, 404)
  }
  if (!page.tokenCipher) {
    throw new AppError(errors.metaTokenExpired, 401)
  }
  let token = ''
  try {
    token = decryptSecret(page.tokenCipher)
  } catch {
    throw new AppError(errors.metaTokenExpired, 401)
  }
  return { page, token }
}

async function rethrowSyncGraphError(page, error) {
  const { MetaPage } = getModels()
  if (error instanceof AppError) {
    if (error.message === errors.metaTokenExpired || error.message === errors.metaTokenInvalid) {
      await markPageTokenExpired(page)
      throw new AppError(error.message, error.statusCode || 401)
    }
    if (
      error.message === errors.metaPermissionMissing
      || error.message === errors.metaFormsPermissionMissing
      || error.message === errors.metaRateLimited
    ) {
      await MetaPage.update(
        { lastError: error.message },
        { where: { id: page.id } },
      )
      throw error
    }
    throw error
  }
  throw new AppError(errors.metaSyncFailed, 502)
}

/**
 * Enqueues the same Sync Now job after a successful Page connect.
 * Never throws — connect must succeed even if enqueue fails (caller surfaces error).
 *
 * @param {object} auth
 * @param {string} metaPageId CRM MetaPage UUID
 * @returns {Promise<{ syncJob: object|null, syncEnqueueError: string }>}
 */
async function enqueueInitialPageSync(auth, metaPageId) {
  try {
    const syncJob = await startPageLeadSync(auth, metaPageId, {})
    console.log(JSON.stringify({
      event: 'meta_initial_sync_enqueued',
      jobId: syncJob.id,
      metaPageId,
      facebookPageId: syncJob.facebookPageId,
      status: syncJob.status,
    }))
    return { syncJob, syncEnqueueError: '' }
  } catch (error) {
    const message = error.message || errors.metaSyncFailed
    console.error(JSON.stringify({
      event: 'meta_initial_sync_enqueue_failed',
      metaPageId,
      message,
    }))
    return { syncJob: null, syncEnqueueError: message }
  }
}

/**
 * Latest sync job for one Page (any status) — used for UI status after connect.
 */
async function getLatestSyncJobForPage(companyId, metaPageId) {
  const { MetaSyncJob } = getModels()
  const job = await MetaSyncJob.findOne({
    where: { companyId, metaPageId },
    order: [['createdAt', 'DESC']],
  })
  return job ? presentSyncJob(job) : null
}

/**
 * Creates or reuses an in-flight sync job for one Page (overlap prevention).
 */
async function startPageLeadSync(auth, pageId, body = {}) {
  const { MetaSyncJob } = getModels()
  const { page } = await loadConnectedPageForSync(auth, pageId)
  const sinceText = readText(body, 'since')
  if (sinceText) {
    const since = new Date(sinceText)
    if (Number.isNaN(since.getTime())) {
      throw new AppError(errors.metaSyncInvalidSince, 400)
    }
  }
  const formId = readText(body, 'formId')

  const existing = await MetaSyncJob.findOne({
    where: {
      companyId: auth.companyId,
      metaPageId: page.id,
      status: { [Op.in]: [metaSyncJobStatuses.pending, metaSyncJobStatuses.processing] },
    },
    order: [['createdAt', 'DESC']],
  })
  if (existing) {
    scheduleSyncJobById(existing.id)
    return presentSyncJob(existing)
  }

  const job = await MetaSyncJob.create({
    id: uuidv4(),
    companyId: auth.companyId,
    metaPageId: page.id,
    facebookPageId: page.pageId,
    createdByUserId: auth.userId,
    status: metaSyncJobStatuses.pending,
    since: sinceText,
    formId,
  })
  console.log(JSON.stringify({
    event: 'meta_sync_job_created',
    jobId: job.id,
    metaPageId: page.id,
    facebookPageId: page.pageId,
  }))
  scheduleSyncJobById(job.id)
  return presentSyncJob(job)
}

async function getPageLeadSyncJob(auth, pageId, jobId) {
  const { MetaSyncJob, MetaPage } = getModels()
  if (!isUuid(pageId) || !isUuid(jobId)) {
    throw new AppError(errors.metaSyncJobNotFound, 404)
  }
  const page = await MetaPage.findOne({
    where: { id: pageId, companyId: auth.companyId },
  })
  if (!page) {
    throw new AppError(errors.metaPageNotFound, 404)
  }
  const job = await MetaSyncJob.findOne({
    where: {
      id: jobId,
      companyId: auth.companyId,
      metaPageId: page.id,
    },
  })
  if (!job) {
    throw new AppError(errors.metaSyncJobNotFound, 404)
  }
  if (job.status === metaSyncJobStatuses.pending) {
    scheduleSyncJobById(job.id)
  } else if (job.status === metaSyncJobStatuses.processing) {
    scheduleSyncJobProcessing()
  }
  return presentSyncJob(job)
}

async function processIngestion(ingestion, graph) {
  const client = graph || graphClient
  const { MetaPage, CatalogItem, MetaWebhookIngestion } = getModels()
  const page = await MetaPage.findOne({
    where: { id: ingestion.metaPageId, pageId: ingestion.pageId },
  })
  if (!page) {
    ingestion.status = metaWebhookIngestionStatuses.failed
    ingestion.lastError = errors.metaPageNotFound
    ingestion.retryCount = security.metaLeadRetryLimit
    await ingestion.save()
    return ingestion
  }
  if (page.status !== metaPageStatuses.connected || !page.tokenCipher) {
    ingestion.status = metaWebhookIngestionStatuses.failed
    ingestion.lastError = errors.metaTokenExpired
    ingestion.retryCount = security.metaLeadRetryLimit
    await ingestion.save()
    return ingestion
  }
  let token = ''
  try {
    token = decryptSecret(page.tokenCipher)
  } catch {
    ingestion.status = metaWebhookIngestionStatuses.failed
    ingestion.lastError = errors.metaTokenExpired
    ingestion.retryCount = security.metaLeadRetryLimit
    await ingestion.save()
    return ingestion
  }

  let graphLead
  try {
    graphLead = await client.readLead(token, ingestion.leadgenId)
  } catch (error) {
    if (error.message === errors.metaTokenExpired || error.message === errors.metaTokenInvalid) {
      await markPageTokenExpired(page)
      ingestion.status = metaWebhookIngestionStatuses.failed
      ingestion.lastError = errors.metaTokenExpired
      ingestion.retryCount = security.metaLeadRetryLimit
      await ingestion.save()
      return ingestion
    }
    if (
      error.message === errors.metaPermissionMissing
      || error.message === errors.metaFormsPermissionMissing
    ) {
      page.lastError = error.message
      await page.save()
      ingestion.status = metaWebhookIngestionStatuses.failed
      ingestion.lastError = error.message
      ingestion.retryCount = security.metaLeadRetryLimit
      await ingestion.save()
      return ingestion
    }
    ingestion.retryCount += 1
    ingestion.lastError = errors.metaExchangeFailed
    ingestion.nextAttemptAt = nextAttemptDate(ingestion.retryCount)
    ingestion.status = ingestion.retryCount >= security.metaLeadRetryLimit
      ? metaWebhookIngestionStatuses.failed
      : metaWebhookIngestionStatuses.pending
    await ingestion.save()
    return ingestion
  }

  const mapped = mapLeadFields(graphLead)
  if (!mapped.name || !isInternationalPhone(mapped.phone)) {
    ingestion.status = metaWebhookIngestionStatuses.failed
    ingestion.lastError = errors.metaLeadIncomplete
    ingestion.retryCount = security.metaLeadRetryLimit
    await ingestion.save()
    return ingestion
  }

  const status = await CatalogItem.findOne({
    where: {
      companyId: ingestion.companyId,
      kind: catalogKinds.status,
      key: 'new',
      isActive: true,
    },
  })
  if (!status) {
    ingestion.status = metaWebhookIngestionStatuses.failed
    ingestion.lastError = errors.statusInactive
    ingestion.retryCount = security.metaLeadRetryLimit
    await ingestion.save()
    return ingestion
  }

  let campaignName = ''
  let adSetName = ''
  let adName = ''
  let formName = ''
  if (client.readObjectName) {
    campaignName = await client.readObjectName(token, mapped.campaignId)
    adSetName = await client.readObjectName(token, mapped.adSetId)
    adName = await client.readObjectName(token, mapped.adId)
    formName = await client.readObjectName(token, mapped.formId)
  }
  let facebookCreatedAt = null
  if (graphLead.created_time) {
    const created = new Date(graphLead.created_time)
    if (!Number.isNaN(created.getTime())) facebookCreatedAt = created
  }

  const actor = await companyActor(ingestion.companyId)
  const metaNote = buildMetaLeadNote({
    pageName: page.name,
    formName,
    formId: mapped.formId,
    leadgenId: ingestion.leadgenId,
    campaignName,
    adSetName,
    adName,
    facebookCreatedAt,
  })

  try {
    const result = await createLead(actor, {
      name: mapped.name,
      phone: mapped.phone,
      email: mapped.email,
      source: leadSources.facebook,
      statusId: status.id,
      metaLeadId: ingestion.leadgenId,
      campaignId: mapped.campaignId,
      campaignName,
      feedback: { type: 'general', text: metaNote },
    })
    ingestion.status = metaWebhookIngestionStatuses.imported
    ingestion.leadId = result.lead.id
    ingestion.lastError = ''
    ingestion.formId = mapped.formId
    ingestion.formName = formName
    ingestion.pageName = page.name
    ingestion.campaignId = mapped.campaignId
    ingestion.campaignName = campaignName
    ingestion.adSetId = mapped.adSetId
    ingestion.adSetName = adSetName
    ingestion.adId = mapped.adId
    ingestion.adName = adName
    if (facebookCreatedAt) ingestion.facebookCreatedAt = facebookCreatedAt
    await ingestion.save()
  } catch (error) {
    if (error.message === errors.metaLeadDuplicate) {
      ingestion.status = metaWebhookIngestionStatuses.skipped
      ingestion.lastError = ''
      await ingestion.save()
      return ingestion
    }
    if (error.message === errors.phoneInvalid || error.message === errors.nameRequired) {
      ingestion.status = metaWebhookIngestionStatuses.failed
      ingestion.lastError = errors.metaLeadIncomplete
      ingestion.retryCount = security.metaLeadRetryLimit
      await ingestion.save()
      return ingestion
    }
    ingestion.retryCount += 1
    ingestion.lastError = errors.requestFailed
    ingestion.nextAttemptAt = nextAttemptDate(ingestion.retryCount)
    ingestion.status = ingestion.retryCount >= security.metaLeadRetryLimit
      ? metaWebhookIngestionStatuses.failed
      : metaWebhookIngestionStatuses.pending
    await ingestion.save()
  }
  return ingestion
}

/**
 * Queues one Graph lead for import; reuses existing ingestion rows when present.
 */
async function queueGraphLead(page, graphLead, graph, companyId) {
  const { MetaWebhookIngestion } = getModels()
  const leadgenId = graphLead.id ? String(graphLead.id) : ''
  if (!leadgenId) return metaWebhookIngestionStatuses.failed
  const formId = graphLead.form_id ? String(graphLead.form_id) : ''
  const dedupeKey = makeDedupeKey(companyId, page.pageId, leadgenId)
  let existing = await MetaWebhookIngestion.findOne({ where: { dedupeKey } })
  if (!existing) {
    try {
      existing = await MetaWebhookIngestion.create({
        id: uuidv4(),
        companyId,
        metaPageId: page.id,
        connectionId: page.connectionId,
        pageId: page.pageId,
        leadgenId,
        formId,
        dedupeKey,
        status: metaWebhookIngestionStatuses.pending,
        pageName: page.name,
      })
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        existing = await MetaWebhookIngestion.findOne({ where: { dedupeKey } })
      } else {
        throw error
      }
    }
  }
  if (!existing) return metaWebhookIngestionStatuses.failed
  if (
    existing.status === metaWebhookIngestionStatuses.imported
    || existing.status === metaWebhookIngestionStatuses.skipped
  ) {
    // Already handled (webhook or prior sync) — count as skipped for this run.
    return metaWebhookIngestionStatuses.skipped
  }
  existing.status = metaWebhookIngestionStatuses.processing
  await existing.save()
  await processIngestion(existing, graph)
  return existing.status
}

async function syncPageLeads(auth, pageId, body, graph, progress) {
  const client = graph || graphClient
  const { page, token } = await loadConnectedPageForSync(auth, pageId)
  const sinceText = readText(body, 'since')
  let since = null
  if (sinceText) {
    since = new Date(sinceText)
    if (Number.isNaN(since.getTime())) {
      throw new AppError(errors.metaSyncInvalidSince, 400)
    }
  }
  const requestedForm = readText(body, 'formId')
  const graphOptions = { pageLimit: security.metaSyncPageLimit }
  let forms = []
  try {
    if (requestedForm) {
      forms = [{ id: requestedForm }]
    } else {
      forms = await client.readLeadgenForms(token, page.pageId, graphOptions)
    }
  } catch (error) {
    await rethrowSyncGraphError(page, error)
  }

  const counts = { imported: 0, skipped: 0, failed: 0, pending: 0 }
  let formsDone = 0
  let leadsSeen = 0
  let formFetchFailures = 0

  if (progress) {
    await progress({
      formsTotal: forms.length,
      formsDone,
      leadsSeen,
      ...counts,
    })
  }

  for (const form of forms) {
    let leads = []
    try {
      leads = await client.readFormLeads(token, form.id, graphOptions)
    } catch (error) {
      formFetchFailures += 1
      if (
        error.message === errors.metaTokenExpired
        || error.message === errors.metaTokenInvalid
        || error.message === errors.metaPermissionMissing
        || error.message === errors.metaFormsPermissionMissing
        || error.message === errors.metaRateLimited
      ) {
        await rethrowSyncGraphError(page, error)
      }
      formsDone += 1
      if (progress) {
        await progress({
          formsTotal: forms.length,
          formsDone,
          leadsSeen,
          ...counts,
        })
      }
      continue
    }
    for (const graphLead of leads) {
      if (leadIsBefore(graphLead, since)) continue
      leadsSeen += 1
      const outcome = await queueGraphLead(page, graphLead, client, auth.companyId)
      if (outcome === metaWebhookIngestionStatuses.imported) counts.imported += 1
      if (outcome === metaWebhookIngestionStatuses.skipped) counts.skipped += 1
      if (outcome === metaWebhookIngestionStatuses.failed) counts.failed += 1
      if (
        outcome === metaWebhookIngestionStatuses.pending
        || outcome === metaWebhookIngestionStatuses.processing
      ) {
        counts.pending += 1
      }
      if (progress && leadsSeen % 5 === 0) {
        await progress({
          formsTotal: forms.length,
          formsDone,
          leadsSeen,
          ...counts,
        })
      }
    }
    formsDone += 1
    if (progress) {
      await progress({
        formsTotal: forms.length,
        formsDone,
        leadsSeen,
        ...counts,
      })
    }
  }

  if (forms.length > 0 && formFetchFailures === forms.length && counts.imported === 0) {
    page.lastError = errors.metaSyncFailed
    await page.save()
    throw new AppError(errors.metaSyncFailed, 502)
  }

  page.lastSyncAt = new Date()
  page.lastError = ''
  await page.save()
  return {
    message: messages.metaLeadsSynced,
    imported: counts.imported,
    skipped: counts.skipped,
    failed: counts.failed,
    pending: counts.pending,
    formsTotal: forms.length,
    formsDone,
    leadsSeen,
  }
}

async function runSyncJob(job, graph) {
  const { MetaSyncJob } = getModels()
  const auth = {
    companyId: job.companyId,
    userId: job.createdByUserId,
  }
  const body = {}
  if (job.since) body.since = job.since
  if (job.formId) body.formId = job.formId
  try {
    const result = await syncPageLeads(auth, job.metaPageId, body, graph, async (progress) => {
      await MetaSyncJob.update({
        imported: progress.imported || 0,
        skipped: progress.skipped || 0,
        failed: progress.failed || 0,
        pending: progress.pending || 0,
        formsTotal: progress.formsTotal || 0,
        formsDone: progress.formsDone || 0,
        leadsSeen: progress.leadsSeen || 0,
      }, { where: { id: job.id } })
    })
    await MetaSyncJob.update({
      status: metaSyncJobStatuses.completed,
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed,
      pending: result.pending,
      formsTotal: result.formsTotal,
      formsDone: result.formsDone,
      leadsSeen: result.leadsSeen,
      errorMessage: '',
      finishedAt: new Date(),
      leaseOwner: null,
    }, { where: { id: job.id } })
  } catch (error) {
    console.error(JSON.stringify({
      event: 'meta_sync_failed',
      jobId: job.id,
      metaPageId: job.metaPageId,
      facebookPageId: job.facebookPageId,
      message: error.message,
    }))
    await MetaSyncJob.update({
      status: metaSyncJobStatuses.failed,
      errorMessage: error.message || errors.metaSyncFailed,
      finishedAt: new Date(),
      leaseOwner: null,
    }, { where: { id: job.id } })
  }
}

/**
 * Atomically claims a pending job by id using leaseOwner (multi-instance safe).
 */
async function processSyncJobById(jobId, graph) {
  const { MetaSyncJob } = getModels()
  const claimed = await MetaSyncJob.findOne({
    where: {
      id: jobId,
      status: metaSyncJobStatuses.pending,
    },
  })
  if (!claimed) return null
  const [affected] = await MetaSyncJob.update(
    {
      status: metaSyncJobStatuses.processing,
      startedAt: new Date(),
      leaseOwner: INSTANCE_ID,
    },
    {
      where: {
        id: jobId,
        status: metaSyncJobStatuses.pending,
      },
    },
  )
  if (!affected) return null
  const job = await MetaSyncJob.findByPk(jobId)
  console.log(JSON.stringify({
    event: 'meta_sync_job_claimed',
    jobId: job.id,
    metaPageId: job.metaPageId,
    facebookPageId: job.facebookPageId,
    leaseOwner: INSTANCE_ID,
  }))
  await runSyncJob(job, graph)
  return job
}

async function failStaleProcessingJobs() {
  const { MetaSyncJob } = getModels()
  const staleBefore = new Date(Date.now() - security.metaSyncStaleMinutes * 60 * 1000)
  await MetaSyncJob.update(
    {
      status: metaSyncJobStatuses.failed,
      errorMessage: errors.metaSyncFailed,
      finishedAt: new Date(),
      leaseOwner: null,
    },
    {
      where: {
        status: metaSyncJobStatuses.processing,
        startedAt: { [Op.lte]: staleBefore },
      },
    },
  )
}

async function processDueSyncJobs(graph) {
  if (syncJobsRunning) return 0
  syncJobsRunning = true
  let processed = 0
  try {
    await failStaleProcessingJobs()
    const { MetaSyncJob } = getModels()
    while (processed < 3) {
      const pending = await MetaSyncJob.findOne({
        where: { status: metaSyncJobStatuses.pending },
        order: [['createdAt', 'ASC']],
      })
      if (!pending) break
      const [affected] = await MetaSyncJob.update(
        {
          status: metaSyncJobStatuses.processing,
          startedAt: new Date(),
          leaseOwner: INSTANCE_ID,
        },
        {
          where: {
            id: pending.id,
            status: metaSyncJobStatuses.pending,
          },
        },
      )
      if (!affected) continue
      const job = await MetaSyncJob.findByPk(pending.id)
      console.log(JSON.stringify({
        event: 'meta_sync_job_claimed',
        jobId: job.id,
        metaPageId: job.metaPageId,
        facebookPageId: job.facebookPageId,
        leaseOwner: INSTANCE_ID,
      }))
      await runSyncJob(job, graph)
      processed += 1
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: 'meta_sync_worker_error',
      message: error.message,
    }))
  } finally {
    syncJobsRunning = false
  }
  return processed
}

async function processDueIngestions(graph) {
  const { MetaWebhookIngestion } = getModels()
  let processed = 0
  while (processed < 10) {
    const due = await MetaWebhookIngestion.findOne({
      where: {
        status: {
          [Op.in]: [metaWebhookIngestionStatuses.pending, metaWebhookIngestionStatuses.received],
        },
        retryCount: { [Op.lt]: security.metaLeadRetryLimit },
        [Op.or]: [
          { nextAttemptAt: null },
          { nextAttemptAt: { [Op.lte]: new Date() } },
        ],
      },
      order: [['createdAt', 'ASC']],
    })
    if (!due) break
    const [affected] = await MetaWebhookIngestion.update(
      { status: metaWebhookIngestionStatuses.processing },
      {
        where: {
          id: due.id,
          status: {
            [Op.in]: [metaWebhookIngestionStatuses.pending, metaWebhookIngestionStatuses.received],
          },
        },
      },
    )
    if (!affected) continue
    const row = await MetaWebhookIngestion.findByPk(due.id)
    await processIngestion(row, graph)
    processed += 1
  }
  return processed
}

function scheduleSyncJobProcessing() {
  if (!syncJobsAutoRunEnabled()) return
  setImmediate(() => {
    processDueSyncJobs().catch((error) => {
      console.error(JSON.stringify({
        event: 'meta_sync_worker_error',
        message: error.message,
      }))
    })
  })
}

function scheduleSyncJobById(jobId) {
  if (!syncJobsAutoRunEnabled()) return
  setImmediate(() => {
    processSyncJobById(jobId).catch((error) => {
      console.error(JSON.stringify({
        event: 'meta_sync_worker_error',
        message: error.message,
      }))
    })
  })
}

function startLeadWorker() {
  if (!syncJobsAutoRunEnabled()) return
  if (!ingestionWorkerTimer) {
    ingestionWorkerTimer = setInterval(() => {
      processDueIngestions().catch((error) => {
        console.error(JSON.stringify({
          event: 'meta_ingestion_worker_error',
          message: error.message,
        }))
      })
      processDueSyncJobs().catch((error) => {
        console.error(JSON.stringify({
          event: 'meta_sync_worker_error',
          message: error.message,
        }))
      })
    }, security.metaLeadPollMs)
    if (typeof ingestionWorkerTimer.unref === 'function') {
      ingestionWorkerTimer.unref()
    }
  }
  if (!syncWorkerTimer) {
    syncWorkerTimer = setInterval(() => {
      processDueSyncJobs().catch((error) => {
        console.error(JSON.stringify({
          event: 'meta_sync_worker_error',
          message: error.message,
        }))
      })
    }, security.metaSyncPollMs)
    if (typeof syncWorkerTimer.unref === 'function') {
      syncWorkerTimer.unref()
    }
  }
  scheduleSyncJobProcessing()
}

function stopLeadWorker() {
  if (ingestionWorkerTimer) {
    clearInterval(ingestionWorkerTimer)
    ingestionWorkerTimer = null
  }
  if (syncWorkerTimer) {
    clearInterval(syncWorkerTimer)
    syncWorkerTimer = null
  }
}

/**
 * Aggregate ingestion outcomes for the company (DB GROUP BY — not full row load).
 *
 * Definitions (Phase 4 UI):
 * - Successfully Imported: status `imported` with a CRM `leadId` (createLead succeeded once).
 * - Duplicate Skipped: status `skipped` (duplicate meta lead / prior import).
 * Pending, processing, received, failed, and ignored are excluded from those two totals.
 * Unique `dedupeKey` prevents double-counting across webhook, initial sync, and Sync Now.
 *
 * @param {object} auth
 * @returns {Promise<{
 *   imported: number,
 *   skipped: number,
 *   pending: number,
 *   failed: number,
 *   pages: Record<string, { imported: number, skipped: number, pending: number, failed: number }>
 * }>}
 */
async function listLeadCounts(auth) {
  const { MetaWebhookIngestion, sequelize } = getModels()
  const countCol = [sequelize.fn('COUNT', sequelize.col('id')), 'total']

  function pageBucket(counts, pageId) {
    if (!counts.pages[pageId]) {
      counts.pages[pageId] = {
        imported: 0,
        skipped: 0,
        pending: 0,
        failed: 0,
      }
    }
    return counts.pages[pageId]
  }

  const counts = {
    imported: 0,
    skipped: 0,
    pending: 0,
    failed: 0,
    pages: {},
  }

  // Successfully Imported = CRM lead created (status imported + leadId present).
  const importedRows = await MetaWebhookIngestion.findAll({
    where: {
      companyId: auth.companyId,
      status: metaWebhookIngestionStatuses.imported,
      leadId: { [Op.ne]: null },
    },
    attributes: ['pageId', countCol],
    group: ['pageId'],
    raw: true,
  })
  for (const row of importedRows) {
    const total = Number(row.total) || 0
    if (!row.pageId || total === 0) continue
    counts.imported += total
    pageBucket(counts, row.pageId).imported += total
  }

  // Duplicate Skipped = durable skipped ingestions (unique dedupeKey; not re-counted on retry).
  const skippedRows = await MetaWebhookIngestion.findAll({
    where: {
      companyId: auth.companyId,
      status: metaWebhookIngestionStatuses.skipped,
    },
    attributes: ['pageId', countCol],
    group: ['pageId'],
    raw: true,
  })
  for (const row of skippedRows) {
    const total = Number(row.total) || 0
    if (!row.pageId || total === 0) continue
    counts.skipped += total
    pageBucket(counts, row.pageId).skipped += total
  }

  // Pending / failed kept for API completeness; excluded from the Phase 4 UI pair.
  const otherRows = await MetaWebhookIngestion.findAll({
    where: {
      companyId: auth.companyId,
      status: {
        [Op.in]: [
          metaWebhookIngestionStatuses.pending,
          metaWebhookIngestionStatuses.processing,
          metaWebhookIngestionStatuses.received,
          metaWebhookIngestionStatuses.failed,
        ],
      },
    },
    attributes: ['pageId', 'status', countCol],
    group: ['pageId', 'status'],
    raw: true,
  })
  for (const row of otherRows) {
    const total = Number(row.total) || 0
    if (!row.pageId || total === 0) continue
    const bucket = pageBucket(counts, row.pageId)
    if (row.status === metaWebhookIngestionStatuses.failed) {
      counts.failed += total
      bucket.failed += total
    } else {
      counts.pending += total
      bucket.pending += total
    }
  }

  return counts
}

/**
 * Page-scoped counts for one connected Meta Page (Facebook pageId + company).
 *
 * @param {object} auth
 * @param {string} facebookPageId
 * @returns {Promise<{ imported: number, skipped: number }>}
 */
async function listPageLeadCounts(auth, facebookPageId) {
  const all = await listLeadCounts(auth)
  const pageId = String(facebookPageId || '')
  const page = all.pages[pageId] || { imported: 0, skipped: 0 }
  return {
    imported: page.imported || 0,
    skipped: page.skipped || 0,
  }
}

module.exports = {
  enqueueInitialPageSync,
  getLatestSyncJobForPage,
  getPageLeadSyncJob,
  listLeadCounts,
  listPageLeadCounts,
  presentSyncJob,
  processDueIngestions,
  processDueSyncJobs,
  processIngestion,
  processSyncJobById,
  queueGraphLead,
  scheduleSyncJobById,
  scheduleSyncJobProcessing,
  startLeadWorker,
  startPageLeadSync,
  stopLeadWorker,
  syncPageLeads,
}
