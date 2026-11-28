const { Sequelize } = require('sequelize')
const { readEnv } = require('./env')

let sequelize

/**
 * Unit-test safety: `npm run test:unit` sets HC_UNIT_TEST_BLOCK_DB=1.
 * Never open MySQL (or return a cached pool) while that flag is set.
 */
function assertMysqlAccessAllowed() {
  if (String(process.env.HC_UNIT_TEST_BLOCK_DB || '') === '1') {
    sequelize = undefined
    throw new Error(
      '[test-isolation] MySQL access is blocked during unit tests (HC_UNIT_TEST_BLOCK_DB=1).',
    )
  }
}

// Exists so every module shares one pooled MySQL connection.
function getSequelize() {
  assertMysqlAccessAllowed()
  if (sequelize) {
    return sequelize
  }
  const env = readEnv()
  sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
    host: env.db.host,
    port: env.db.port,
    dialect: env.db.dialect,
    logging: env.db.logging ? console.log : false,
    dialectOptions: {
      connectTimeout: 10000,
    },
    pool: {
      max: 10,
      min: 0,
      acquire: 20000,
      idle: 10000,
    },
    define: {
      underscored: false,
      freezeTableName: true,
      timestamps: true,
    },
  })
  return sequelize
}

async function assertDatabaseConnection() {
  assertMysqlAccessAllowed()
  const client = getSequelize()
  await client.authenticate()
  return true
}

/**
 * Closes the shared pool when one exists.
 * Under unit-test DB block: never touches MySQL — only clears the in-memory singleton.
 */
async function closeDatabase() {
  if (String(process.env.HC_UNIT_TEST_BLOCK_DB || '') === '1') {
    sequelize = undefined
    return
  }
  if (!sequelize) {
    return
  }
  await sequelize.close()
  sequelize = undefined
}

module.exports = {
  getSequelize,
  assertDatabaseConnection,
  closeDatabase,
  assertMysqlAccessAllowed,
}
