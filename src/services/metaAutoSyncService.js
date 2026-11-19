const { readMetaAutoSyncConfig } = require('../config/metaAutoSync')
const { getModels } = require('../models')
const { metaConnectionStatuses, metaPageStatuses } = require('../utils/enums')
const { startPageLeadSync } = require('./metaLeadService')

let autoSyncTimer = null
let tickRunning = false

/**
 * META_SYNC_AUTORUN worker gate — separate from periodic Auto Sync.
 * Exposed for startup warnings only.
 */
function syncJobsWorkerAutorunEnabled() {
  return process.env.META_SYNC_AUTORUN !== '0'
}

/**
 * Enqueue a sync job for every connected Meta page (company-scoped).
 * Does not call Graph itself; relies on META_SYNC_AUTORUN workers / Manual Sync path.
 *
 * @param {{ startPageLeadSync?: typeof startPageLeadSync }} [options]
 */
async function runMetaAutoSyncTick(options = {}) {
  const enqueue = options.startPageLeadSync || startPageLeadSync
  if (tickRunning) {
    return { skipped: true, reason: 'already_running', results: [] }
  }
  tickRunning = true
  try {
    const { MetaPage, MetaConnection } = getModels()
    const pages = await MetaPage.findAll({
      where: { status: metaPageStatuses.connected },
      include: [{
        model: MetaConnection,
        required: true,
        where: { status: metaConnectionStatuses.connected },
      }],
      order: [['createdAt', 'ASC']],
    })

    const results = []
    for (const page of pages) {
      const connection = page.MetaConnection
      const userId = connection && connection.connectedBy
      if (!userId) {
        results.push({
          metaPageId: page.id,
          companyId: page.companyId,
          status: 'skipped',
          reason: 'missing_connected_by',
        })
        continue
      }
      try {
        const job = await enqueue(
          { companyId: page.companyId, userId },
          page.id,
          {},
        )
        results.push({
          metaPageId: page.id,
          companyId: page.companyId,
          status: 'enqueued',
          jobId: job && job.id ? job.id : null,
        })
      } catch (error) {
        const message = error && error.message
          ? String(error.message).slice(0, 200)
          : 'auto_sync_page_failed'
        console.error(JSON.stringify({
          event: 'meta_auto_sync_page_failed',
          companyId: page.companyId,
          metaPageId: page.id,
          message,
        }))
        results.push({
          metaPageId: page.id,
          companyId: page.companyId,
          status: 'failed',
          message,
        })
      }
    }

    console.log(JSON.stringify({
      event: 'meta_auto_sync_tick',
      pages: pages.length,
      enqueued: results.filter((r) => r.status === 'enqueued').length,
      failed: results.filter((r) => r.status === 'failed').length,
    }))
    return { skipped: false, results }
  } finally {
    tickRunning = false
  }
}

/**
 * Start the periodic Auto Sync timer. Interval comes only from env config.
 *
 * @param {{
 *   config?: ReturnType<typeof readMetaAutoSyncConfig>,
 *   allowInTest?: boolean,
 *   setIntervalFn?: typeof setInterval,
 * }} [options]
 * @returns {NodeJS.Timeout|null}
 */
function startMetaAutoSyncScheduler(options = {}) {
  const config = options.config || readMetaAutoSyncConfig()
  if (!config.enabled) {
    console.log(JSON.stringify({
      event: 'meta_auto_sync_scheduler_disabled',
      message: 'Periodic Meta Auto Sync is off (META_AUTO_SYNC_ENABLED=false). Webhooks and Manual Sync Now are unaffected.',
    }))
    return null
  }

  if (process.env.NODE_ENV === 'test' && !options.allowInTest) {
    return null
  }

  if (autoSyncTimer) {
    return autoSyncTimer
  }

  if (!syncJobsWorkerAutorunEnabled()) {
    console.warn(JSON.stringify({
      event: 'meta_auto_sync_autorun_warning',
      message: 'META_AUTO_SYNC_ENABLED is true but META_SYNC_AUTORUN=0. Periodic jobs will enqueue but will not run until the sync worker autorun is enabled.',
    }))
  }

  const intervalMs = config.intervalMs
  const schedule = options.setIntervalFn || setInterval
  autoSyncTimer = schedule(() => {
    runMetaAutoSyncTick().catch((error) => {
      console.error(JSON.stringify({
        event: 'meta_auto_sync_scheduler_error',
        message: error && error.message
          ? String(error.message).slice(0, 200)
          : 'scheduler_error',
      }))
    })
  }, intervalMs)

  if (autoSyncTimer && typeof autoSyncTimer.unref === 'function') {
    autoSyncTimer.unref()
  }

  console.log(JSON.stringify({
    event: 'meta_auto_sync_scheduler_started',
    intervalMinutes: config.intervalMinutes,
    intervalMs,
    note: 'Interval is read from META_AUTO_SYNC_INTERVAL_MINUTES (not hardcoded). Restart after .env changes.',
  }))
  return autoSyncTimer
}

function stopMetaAutoSyncScheduler() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer)
    autoSyncTimer = null
  }
}

function isMetaAutoSyncSchedulerRunning() {
  return autoSyncTimer != null
}

/** Test helper: reset in-memory scheduler state. */
function resetMetaAutoSyncSchedulerForTests() {
  stopMetaAutoSyncScheduler()
  tickRunning = false
}

module.exports = {
  runMetaAutoSyncTick,
  startMetaAutoSyncScheduler,
  stopMetaAutoSyncScheduler,
  isMetaAutoSyncSchedulerRunning,
  resetMetaAutoSyncSchedulerForTests,
  syncJobsWorkerAutorunEnabled,
}
