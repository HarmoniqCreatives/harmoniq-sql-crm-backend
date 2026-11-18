'use strict'

/**
 * Shared database environment policy for Local and Production.
 * Connection details (including DB_NAME) come exclusively from environment variables.
 * No hardcoded database names — changing DB_NAME in .env switches the target database.
 */

const DB_ENV_LOCAL = 'local'
const DB_ENV_PRODUCTION = 'production'

const ALLOWED_DB_ENVS = new Set([DB_ENV_LOCAL, DB_ENV_PRODUCTION])

/**
 * @param {NodeJS.ProcessEnv} [envSource]
 * @returns {{
 *   dbEnv: 'local'|'production',
 *   nodeEnv: string,
 *   host: string,
 *   port: number,
 *   name: string,
 *   user: string,
 *   password: string,
 *   dialect: 'mysql',
 *   logging: boolean,
 * }}
 */
function resolveDatabaseConfig(envSource = process.env) {
  const dbEnv = String(envSource.DB_ENV || '').trim()
  const nodeEnv = String(envSource.NODE_ENV || '').trim()
  const dbName = String(envSource.DB_NAME || '').trim()
  const host = String(envSource.DB_HOST || '').trim()
  const user = String(envSource.DB_USER || '').trim()
  const password = envSource.DB_PASSWORD
  const portRaw = String(envSource.DB_PORT || '').trim()

  if (!dbEnv) {
    throw new Error('Missing required environment variable: DB_ENV (expected "local" or "production")')
  }
  if (!ALLOWED_DB_ENVS.has(dbEnv)) {
    throw new Error(`Invalid DB_ENV="${dbEnv}". Expected "local" or "production".`)
  }

  if (!nodeEnv) {
    throw new Error('Missing required environment variable: NODE_ENV')
  }

  if (!dbName) {
    throw new Error('Missing required environment variable: DB_NAME')
  }
  if (!host) {
    throw new Error('Missing required environment variable: DB_HOST')
  }
  if (!portRaw) {
    throw new Error('Missing required environment variable: DB_PORT')
  }
  if (!user) {
    throw new Error('Missing required environment variable: DB_USER')
  }
  if (password == null || String(password) === '') {
    throw new Error('Missing required environment variable: DB_PASSWORD')
  }

  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid DB_PORT="${portRaw}". Expected an integer 1–65535.`)
  }

  if (dbEnv === DB_ENV_LOCAL) {
    if (nodeEnv === 'production') {
      throw new Error('DB_ENV=local is incompatible with NODE_ENV=production')
    }
    if (nodeEnv !== 'development' && nodeEnv !== 'test') {
      throw new Error(
        `DB_ENV=local requires NODE_ENV=development or NODE_ENV=test (got "${nodeEnv}")`,
      )
    }
  }

  if (dbEnv === DB_ENV_PRODUCTION) {
    if (nodeEnv !== 'production') {
      throw new Error(
        `DB_ENV=production requires NODE_ENV=production (got "${nodeEnv}")`,
      )
    }
  }

  return {
    dbEnv,
    nodeEnv,
    host,
    port,
    name: dbName,
    user,
    password: String(password),
    dialect: 'mysql',
    logging: String(envSource.DB_LOGGING || '') === '1',
  }
}

module.exports = {
  resolveDatabaseConfig,
  DB_ENV_LOCAL,
  DB_ENV_PRODUCTION,
}
