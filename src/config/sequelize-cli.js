require('dotenv').config()

const shared = {
  username: process.env.DB_USER || 'harmoniq',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'harmoniq_creative_crm',
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  dialect: 'mysql',
  logging: false,
}

module.exports = {
  development: { ...shared },
  test: {
    ...shared,
    database: process.env.DB_NAME_TEST || 'harmoniq_creative_crm_test',
  },
  production: { ...shared },
}
