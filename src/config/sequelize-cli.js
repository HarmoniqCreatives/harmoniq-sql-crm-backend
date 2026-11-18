'use strict'

require('dotenv').config()

const { resolveDatabaseConfig } = require('./dbEnv')

/**
 * Shared Sequelize CLI config for Local and Production.
 * Uses the same env-driven resolveDatabaseConfig as the runtime app (DB_NAME from .env).
 */
function buildConfig() {
  const db = resolveDatabaseConfig(process.env)
  return {
    username: db.user,
    password: db.password,
    database: db.name,
    host: db.host,
    port: db.port,
    dialect: db.dialect,
    logging: false,
  }
}

const shared = buildConfig()

module.exports = {
  development: { ...shared },
  test: { ...shared },
  production: { ...shared },
}
