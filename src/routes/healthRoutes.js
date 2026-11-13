const express = require('express')
const { getSequelize } = require('../config/database')

const healthRouter = express.Router()

healthRouter.get('/health', async (req, res) => {
  let database = 'disconnected'
  try {
    await getSequelize().authenticate()
    database = 'connected'
  } catch (error) {
    database = 'error'
  }

  const healthy = database === 'connected'
  res.status(healthy ? 200 : 503).json({
    data: {
      status: healthy ? 'ok' : 'degraded',
      message: healthy
        ? 'Harmoniq Creative CRM API is running.'
        : 'API is up but MySQL is not reachable.',
      database,
      orm: 'sequelize',
      product: 'Harmoniq Creative CRM',
    },
  })
})

module.exports = { healthRouter }
