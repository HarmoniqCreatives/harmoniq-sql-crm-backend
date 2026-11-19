/**
 * Periodic Meta Auto Sync (Graph page lead pull) — env only.
 *
 * Distinct from META_SYNC_AUTORUN:
 * - META_AUTO_SYNC_* schedules periodic enqueue of page sync jobs.
 * - META_SYNC_AUTORUN runs the in-process workers that process webhooks + queued sync jobs.
 */

const ALLOWED_INTERVAL_MINUTES = Object.freeze([10, 15])
const DEFAULT_INTERVAL_MINUTES = 10

/**
 * @param {string} name
 * @param {string|undefined|null} raw
 * @param {boolean} defaultValue
 */
function parseEnabledFlag(name, raw, defaultValue) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue
  }
  const value = String(raw).trim().toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(
    `${name} must be true or false (accepted: true|false|1|0). Got: ${JSON.stringify(String(raw))}`,
  )
}

/**
 * @param {string|undefined|null} raw
 */
function parseIntervalMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_INTERVAL_MINUTES
  }
  const trimmed = String(raw).trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `META_AUTO_SYNC_INTERVAL_MINUTES must be one of ${ALLOWED_INTERVAL_MINUTES.join(' or ')} minutes. Got: ${JSON.stringify(trimmed)}`,
    )
  }
  const minutes = Number(trimmed)
  if (!ALLOWED_INTERVAL_MINUTES.includes(minutes)) {
    throw new Error(
      `META_AUTO_SYNC_INTERVAL_MINUTES must be one of ${ALLOWED_INTERVAL_MINUTES.join(' or ')} minutes. Got: ${minutes}`,
    )
  }
  return minutes
}

/**
 * Read and validate Meta Auto Sync schedule settings from the environment.
 * Throws on invalid values so startup fails loudly.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ enabled: boolean, intervalMinutes: number, intervalMs: number }}
 */
function readMetaAutoSyncConfig(env = process.env) {
  const enabled = parseEnabledFlag('META_AUTO_SYNC_ENABLED', env.META_AUTO_SYNC_ENABLED, false)
  const intervalMinutes = parseIntervalMinutes(env.META_AUTO_SYNC_INTERVAL_MINUTES)
  return {
    enabled,
    intervalMinutes,
    intervalMs: intervalMinutes * 60 * 1000,
  }
}

/**
 * Validate env at process start. Returns the resolved config for logging.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
function assertMetaAutoSyncConfig(env = process.env) {
  return readMetaAutoSyncConfig(env)
}

module.exports = {
  ALLOWED_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  readMetaAutoSyncConfig,
  assertMetaAutoSyncConfig,
}
