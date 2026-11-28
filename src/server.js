const cookieParser = require('cookie-parser')
const cors = require('cors')
const express = require('express')
const helmet = require('helmet')
const morgan = require('morgan')
const rateLimit = require('express-rate-limit')
const { readEnv } = require('./config/env')
const { assertDatabaseConnection, closeDatabase } = require('./config/database')
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler')
const { healthRouter } = require('./routes/healthRoutes')
const { authRouter } = require('./modules/auth/authRoutes')
const { userRouter } = require('./modules/users/userRoutes')
const { roleRouter } = require('./modules/roles/roleRoutes')
const { invitationRouter } = require('./modules/invitations/invitationRoutes')
const { catalogRouter } = require('./modules/catalog/catalogRoutes')
const { companyRouter } = require('./modules/company/companyRoutes')
const { leadRouter } = require('./modules/leads/leadRoutes')
const { metaRouter } = require('./modules/meta/metaRoutes')
const { metaWebhookRouter } = require('./modules/meta/metaWebhookRoutes')
const { whatsappRouter } = require('./modules/whatsapp/whatsappRoutes')
const { whatsappWebhookRouter } = require('./modules/whatsapp/whatsappWebhookRoutes')
const { recycleBinRouter } = require('./modules/recycleBin/recycleBinRoutes')
const { notificationRouter } = require('./modules/notifications/notificationRoutes')
const { publicRouter } = require('./routes/publicRoutes')
const { warnMailProviderAtStartup } = require('./services/mailService')
const { startLeadWorker, stopLeadWorker } = require('./services/metaLeadService')
const {
  startMetaAutoSyncScheduler,
  stopMetaAutoSyncScheduler,
} = require('./services/metaAutoSyncService')
const {
  startEmailReportWorker,
  stopEmailReportWorker,
} = require('./services/emailReportService')
const {
  startWhatsAppOutboxWorker,
  stopWhatsAppOutboxWorker,
} = require('./services/whatsappOutboxService')
const {
  startNotificationPushWorker,
  stopNotificationPushWorker,
} = require('./services/notificationPushService')
const {
  startFollowUpReminderWorker,
  stopFollowUpReminderWorker,
} = require('./services/followUpReminderService')
const { assertMetaEncryptionKey } = require('./utils/metaSecrets')
const { assertMetaAutoSyncConfig } = require('./config/metaAutoSync')

// Tests may omit the key in process env; provide a fixed 32-byte hex for NODE_ENV=test only.
if (process.env.NODE_ENV === 'test' && !process.env.META_TOKEN_ENCRYPTION_KEY) {
  process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('hex')
}
assertMetaEncryptionKey()
assertMetaAutoSyncConfig()

const env = readEnv()
const app = express()

app.set('trust proxy', env.trustProxyHops)
app.use(helmet())
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'))
app.use(cors({
  origin: env.frontendUrl,
  credentials: true,
}))

// Meta + WhatsApp webhooks must see exact raw bytes before JSON parsing.
app.use('/api/meta', metaWebhookRouter)
app.use('/api/whatsapp', whatsappWebhookRouter)

app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_TEST !== '1',
}))

warnMailProviderAtStartup()

app.use('/api', healthRouter)
app.use('/api/public', publicRouter)
app.use('/api/auth', authRouter)
app.use('/api/users', userRouter)
app.use('/api/roles', roleRouter)
app.use('/api/invitations', invitationRouter)
app.use('/api/catalog', catalogRouter)
app.use('/api/company', companyRouter)
app.use('/api/leads', leadRouter)
app.use('/api/meta', metaRouter)
app.use('/api/whatsapp', whatsappRouter)
app.use('/api/recycle-bin', recycleBinRouter)
app.use('/api/notifications', notificationRouter)

app.get('/api', (req, res) => {
  res.status(200).json({
    data: {
      product: 'Harmoniq Creative CRM',
      phase: 'notifications',
      orm: 'sequelize',
      message: 'Auth, Users, Roles, Catalog, Company, Leads, Meta, WhatsApp and Notifications APIs are available.',
    },
  })
})

app.use(notFoundHandler)
app.use(errorHandler)

/** @type {import('http').Server | null} */
let httpServer = null
let shuttingDown = false

function stopAllWorkers() {
  stopLeadWorker()
  stopMetaAutoSyncScheduler()
  stopEmailReportWorker()
  stopWhatsAppOutboxWorker()
  stopNotificationPushWorker()
  stopFollowUpReminderWorker()
}

/**
 * Graceful shutdown for SIGINT / SIGTERM.
 * Stops workers, closes HTTP server, then the DB pool.
 */
async function gracefulShutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] received ${signal}`)
  stopAllWorkers()
  const forceTimer = setTimeout(() => {
    console.error('[shutdown] timed out; forcing exit')
    process.exit(1)
  }, 15_000)
  if (typeof forceTimer.unref === 'function') forceTimer.unref()

  try {
    if (httpServer) {
      await new Promise((resolve) => {
        httpServer.close(() => resolve())
      })
    }
  } catch (error) {
    console.error(`[shutdown] HTTP close error: ${error.message}`)
  }

  try {
    await closeDatabase()
  } catch (error) {
    console.error(`[shutdown] DB close error: ${error.message}`)
  }

  process.exit(0)
}

async function start() {
  let dbOk = false
  try {
    await assertDatabaseConnection()
    dbOk = true
    console.log('Sequelize connected to MySQL.')
  } catch (error) {
    console.error(`Sequelize could not connect to MySQL: ${error.message}`)
    console.error('Install and start native MySQL Server, then run: npm run db:migrate')
    if (env.nodeEnv === 'production' || env.dbEnv === 'production') {
      console.error('[startup] Refusing to listen in production without a database connection.')
      process.exit(1)
    }
  }

  if (dbOk) {
    startLeadWorker()
    startMetaAutoSyncScheduler()
    startEmailReportWorker()
    startWhatsAppOutboxWorker()
    startNotificationPushWorker()
    startFollowUpReminderWorker()
  } else {
    console.error('[startup] Skipping background workers until MySQL is available.')
  }

  httpServer = app.listen(env.port, () => {
    console.log(`Harmoniq Creative CRM API listening on port ${env.port}`)
  })
  return httpServer
}

if (require.main === module) {
  start()
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch((error) => {
    console.error(error)
    process.exit(1)
  })
})

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch((error) => {
    console.error(error)
    process.exit(1)
  })
})

module.exports = { app, start, gracefulShutdown }
