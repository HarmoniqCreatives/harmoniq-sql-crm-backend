const { Sequelize } = require('sequelize')
const { readEnv } = require('./env')

let sequelize

// Exists so every module shares one pooled MySQL connection.
function getSequelize() {
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
  const client = getSequelize()
  await client.authenticate()
  return true
}

async function closeDatabase() {
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
}
