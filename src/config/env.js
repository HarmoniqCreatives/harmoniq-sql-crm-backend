const dotenv = require('dotenv')

dotenv.config()

function required(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function readEnv() {
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 1)
  if (!Number.isFinite(trustProxyHops) || trustProxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative number (never true).')
  }
  return {
    port: Number(process.env.PORT || 5001),
    nodeEnv: process.env.NODE_ENV || 'development',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5174',
    appBaseUrl: process.env.APP_BASE_URL || '',
    jwtAccessSecret: required('JWT_ACCESS_SECRET'),
    jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
    jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
    jwtRefreshTtl: process.env.JWT_REFRESH_TTL || '7d',
    trustProxyHops,
    mailProvider: process.env.MAIL_PROVIDER || '',
    metaAppId: process.env.META_APP_ID || '',
    metaRedirectUri: process.env.META_REDIRECT_URI || '',
    metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || process.env.META_GRAPH_VERSION || 'v21.0',
    db: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      name: process.env.DB_NAME || 'harmoniq_creative_crm',
      user: process.env.DB_USER || 'harmoniq',
      password: process.env.DB_PASSWORD || '',
      dialect: 'mysql',
      logging: process.env.DB_LOGGING === '1',
    },
  }
}

module.exports = { readEnv }
