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
const { publicRouter } = require('./routes/publicRoutes')
const { warnMailProviderAtStartup } = require('./services/mailService')
const { startLeadWorker, stopLeadWorker } = require('./services/metaLeadService')
const { assertMetaEncryptionKey } = require('./utils/metaSecrets')

// Tests may omit the key in process env; provide a fixed 32-byte hex for NODE_ENV=test only.
if (process.env.NODE_ENV === 'test' && !process.env.META_TOKEN_ENCRYPTION_KEY) {
  process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('hex')
}
assertMetaEncryptionKey()

const env = readEnv()
const app = express()

app.set('trust proxy', env.trustProxyHops)
app.use(helmet())
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'))
app.use(cors({
  origin: env.frontendUrl,
  credentials: true,
}))

// Meta webhook must see exact raw bytes before JSON parsing.
app.use('/api/meta', metaWebhookRouter)

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

app.get('/api', (req, res) => {
  res.status(200).json({
    data: {
      product: 'Harmoniq Creative CRM',
      phase: 'meta-foundation',
      orm: 'sequelize',
      message: 'Auth, Users, Roles, Catalog, Company, Leads and Meta Integration APIs are available.',
    },
  })
})

app.use(notFoundHandler)
app.use(errorHandler)

async function start() {
  try {
    await assertDatabaseConnection()
    console.log('Sequelize connected to MySQL.')
  } catch (error) {
    console.error(`Sequelize could not connect to MySQL: ${error.message}`)
    console.error('Install and start native MySQL Server, then run: npm run db:migrate')
  }

  startLeadWorker()

  app.listen(env.port, () => {
    console.log(`Harmoniq Creative CRM API listening on port ${env.port}`)
  })
}

if (require.main === module) {
  start()
}

process.on('SIGINT', async () => {
  stopLeadWorker()
  await closeDatabase()
  process.exit(0)
})

module.exports = { app, start }
