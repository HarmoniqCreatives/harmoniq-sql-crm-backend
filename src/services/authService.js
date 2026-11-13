const { v4: uuidv4 } = require('uuid')
const { Op } = require('sequelize')
const { security } = require('../config/security')
const { catalogSeeds, companyDefaults, roleSeeds } = require('../config/seed')
const { getModels } = require('../models')
const { companyStatuses, roleKeys, userStatuses } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  addHours,
  addMinutes,
  checkPassword,
  createSecretToken,
  hashPassword,
  hashSecret,
  isEmail,
  isInternationalPhone,
  isWithinLength,
  normalizeEmail,
  normalizeNameKey,
  normalizePhone,
  readText,
  requirePassword,
} = require('../utils/helpers')
const {
  sendPasswordResetEmail,
  sendVerificationEmail,
} = require('./mailService')
const {
  createSession,
  revokeAllUserSessions,
  revokeRefreshToken,
  rotateRefreshToken,
} = require('./tokenService')

/**
 * Authentication service: company registration, verification, login, and password reset.
 * Tenant context for private routes always comes from session/JWT, never client body.
 */

/**
 * Auth-facing user payload including role permissions for the SPA.
 *
 * @param {object} user
 * @param {object|null} role
 * @param {object|null} company
 * @returns {object}
 */
function presentUser(user, role, company) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    status: user.status,
    emailVerified: user.emailVerified,
    isInitialSuperAdmin: user.isInitialSuperAdmin,
    company: company ? {
      id: company.id,
      name: company.name,
      status: company.status,
      timezone: company.timezone,
      baseCurrency: company.baseCurrency,
    } : null,
    role: role ? {
      id: role.id,
      key: role.key,
      name: role.name,
      scope: role.scope,
      isProtected: Boolean(role.isProtected),
      permissions: role.permissions || [],
    } : null,
  }
}

function readPassword(body) {
  if (!body || typeof body.password !== 'string') {
    return ''
  }
  return body.password
}

function readConfirmPassword(body) {
  if (!body || typeof body.confirmPassword !== 'string') {
    return ''
  }
  return body.confirmPassword
}

/**
 * Registers a company and its initial Super Admin inside a single transaction.
 * Partial signup cannot leave orphan users/roles when a unique constraint fails.
 *
 * @param {object} body companyName, adminName, email, phone, password, confirmPassword
 * @returns {Promise<{ message: string, emailDelivery: string, companyId: string, userId: string }>}
 */
async function registerCompany(body) {
  const { sequelize, Company, Role, User, CatalogItem } = getModels()
  const companyName = readText(body, 'companyName')
  const adminName = readText(body, 'adminName') || readText(body, 'name')
  const email = normalizeEmail(readText(body, 'email'))
  const password = readPassword(body)
  const confirmPassword = readConfirmPassword(body)
  const { findDialCountryByName, nationalDigits } = require('./dialCountryService')

  if (!companyName) {
    throw new AppError(errors.companyNameRequired, 400)
  }
  if (!isWithinLength(companyName, security.companyNameMaxLength)) {
    throw new AppError(errors.valueTooLong, 400)
  }
  if (!adminName) {
    throw new AppError(errors.nameRequired, 400)
  }
  if (!isWithinLength(adminName, security.nameMaxLength)) {
    throw new AppError(errors.valueTooLong, 400)
  }
  if (!email) {
    throw new AppError(errors.emailRequired, 400)
  }
  if (!isEmail(email)) {
    throw new AppError(errors.emailInvalid, 400)
  }

  // Prefer country + local mobile (DB dial catalog). Fall back to full E.164 phone for tests/API clients.
  let phone = ''
  const countryName = readText(body, 'country')
  const mobileRaw = readText(body, 'mobile')
  if (countryName || mobileRaw || readText(body, 'countryCode')) {
    if (!countryName) {
      throw new AppError(errors.countryRequired, 400)
    }
    const country = await findDialCountryByName(countryName)
    const countryCode = readText(body, 'countryCode')
    if (countryCode && countryCode !== country.code) {
      throw new AppError(errors.countryInvalid, 400)
    }
    const digits = nationalDigits(mobileRaw)
    if (!digits) {
      throw new AppError(errors.phoneRequired, 400)
    }
    phone = `${country.code}${digits}`
  } else {
    const phoneRaw = readText(body, 'phone')
    if (!phoneRaw) {
      throw new AppError(errors.phoneRequired, 400)
    }
    phone = normalizePhone(phoneRaw)
  }
  if (!isInternationalPhone(phone)) {
    throw new AppError(errors.phoneInvalid, 400)
  }
  requirePassword(password)
  if (!confirmPassword) {
    throw new AppError(errors.confirmPasswordRequired, 400)
  }
  if (confirmPassword !== password) {
    throw new AppError(errors.passwordMismatch, 400)
  }

  const nameKey = normalizeNameKey(companyName)
  if (!nameKey) {
    throw new AppError(errors.companyNameRequired, 400)
  }

  const verifyToken = createSecretToken()
  const passwordHash = await hashPassword(password)
  let companyId
  let userId

  try {
    await sequelize.transaction(async (transaction) => {
      const company = await Company.create({
        id: uuidv4(),
        name: companyName,
        nameKey,
        timezone: companyDefaults.timezone,
        baseCurrency: companyDefaults.baseCurrency,
        enabledCurrencies: companyDefaults.enabledCurrencies,
        isActive: false,
        status: companyStatuses.pendingVerification,
      }, { transaction })
      companyId = company.id

      const roles = []
      for (const seed of roleSeeds) {
        const role = await Role.create({
          id: uuidv4(),
          companyId: company.id,
          key: seed.key,
          name: seed.name,
          description: seed.description,
          permissions: seed.permissions,
          scope: seed.scope,
          isSystem: seed.isSystem,
          isProtected: seed.isProtected,
        }, { transaction })
        roles.push(role)
      }
      const superAdminRole = roles.find((role) => role.key === roleKeys.superAdmin)

      for (const seed of catalogSeeds) {
        await CatalogItem.create({
          id: uuidv4(),
          companyId: company.id,
          kind: seed.kind,
          key: seed.key,
          name: seed.name,
          sortOrder: seed.sortOrder,
          tone: seed.tone,
          isActive: true,
          isSystem: true,
        }, { transaction })
      }

      const user = await User.create({
        id: uuidv4(),
        companyId: company.id,
        roleId: superAdminRole.id,
        name: adminName,
        email,
        phone,
        passwordHash,
        status: userStatuses.pending,
        emailVerified: false,
        isInitialSuperAdmin: true,
        emailVerifyTokenHash: hashSecret(verifyToken),
        emailVerifyExpiresAt: addHours(new Date(), security.verifyHours),
      }, { transaction })
      userId = user.id
    })
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      const fields = error.fields || {}
      if (fields.nameKey || Object.keys(fields).includes('nameKey')) {
        throw new AppError(errors.companyNameTaken, 409)
      }
      throw new AppError(errors.emailTaken, 409)
    }
    throw error
  }

  let emailDelivery = 'sent'
  try {
    await sendVerificationEmail({
      to: email,
      recipientName: adminName,
      companyName,
      token: verifyToken,
    })
  } catch (error) {
    emailDelivery = 'failed'
  }

  return {
    message: emailDelivery === 'sent' ? messages.signupComplete : messages.signupCompletePendingMail,
    emailDelivery,
    companyId,
    userId,
  }
}

async function verifyEmail(token) {
  const { sequelize, Company, User, Role } = getModels()
  if (!token) {
    throw new AppError(errors.verifyTokenInvalid, 400)
  }
  const tokenHash = hashSecret(token)
  let verifiedUser
  let verifiedCompany

  await sequelize.transaction(async (transaction) => {
    const user = await User.findOne({
      where: { emailVerifyTokenHash: tokenHash },
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
    if (!user) {
      throw new AppError(errors.verifyTokenInvalid, 400)
    }
    if (user.emailVerified) {
      throw new AppError(errors.verifyTokenUsed, 409)
    }
    if (!user.emailVerifyExpiresAt || user.emailVerifyExpiresAt.getTime() < Date.now()) {
      throw new AppError(errors.verifyTokenExpired, 400)
    }
    const company = await Company.findByPk(user.companyId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
    if (!company) {
      throw new AppError(errors.verifyTokenInvalid, 400)
    }

    user.emailVerified = true
    user.status = userStatuses.active
    user.emailVerifyTokenHash = null
    user.emailVerifyExpiresAt = null
    await user.save({ transaction })

    company.status = companyStatuses.active
    company.isActive = true
    await company.save({ transaction })

    verifiedUser = user
    verifiedCompany = company
  })

  const role = await Role.findByPk(verifiedUser.roleId)
  return {
    message: messages.emailVerified,
    user: presentUser(verifiedUser, role, verifiedCompany),
  }
}

async function resendVerification(body) {
  const { Company, User } = getModels()
  const email = normalizeEmail(readText(body, 'email'))
  const companyId = readText(body, 'companyId')
  if (!email || !isEmail(email)) {
    throw new AppError(errors.emailInvalid, 400)
  }
  const where = { email, emailVerified: false }
  if (companyId) {
    where.companyId = companyId
  }
  const user = await User.findOne({ where })
  if (!user) {
    return { message: messages.verificationResent }
  }
  if (user.emailVerifyExpiresAt) {
    const earliest = addMinutes(user.updatedAt || user.createdAt, security.resendVerifyMinutes)
    if (earliest.getTime() > Date.now() && user.emailVerifyTokenHash) {
      return { message: messages.verificationResent }
    }
  }
  const company = await Company.findByPk(user.companyId)
  const token = createSecretToken()
  user.emailVerifyTokenHash = hashSecret(token)
  user.emailVerifyExpiresAt = addHours(new Date(), security.verifyHours)
  await user.save()
  try {
    await sendVerificationEmail({
      to: user.email,
      recipientName: user.name,
      companyName: company ? company.name : 'Harmoniq Creative CRM',
      token,
    })
  } catch (error) {
    throw new AppError(errors.signupEmailFailed, 502)
  }
  return { message: messages.verificationResent }
}

async function listCompaniesForEmail(emailRaw) {
  const { Company, User } = getModels()
  const email = normalizeEmail(emailRaw)
  if (!email || !isEmail(email)) {
    return { companies: [] }
  }
  const users = await User.findAll({
    where: { email },
    attributes: ['companyId'],
  })
  if (users.length === 0) {
    return { companies: [] }
  }
  const companies = await Company.findAll({
    where: {
      id: { [Op.in]: users.map((user) => user.companyId) },
    },
    attributes: ['id', 'name', 'status'],
    order: [['name', 'ASC']],
  })
  return {
    companies: companies.map((company) => ({
      id: company.id,
      name: company.name,
      status: company.status,
    })),
  }
}

/**
 * Authenticates email/password for one company context and creates a session.
 * Shared emails across tenants require explicit `companyId`.
 *
 * @param {object} body email, password, companyId?
 * @param {{ userAgent?: string, ipAddress?: string }} [meta]
 * @returns {Promise<object>}
 */
async function login(body, meta = {}) {
  const { Company, User, Role } = getModels()
  const email = normalizeEmail(readText(body, 'email'))
  const password = readPassword(body)
  const companyId = readText(body, 'companyId')
  if (!email || !password) {
    throw new AppError(errors.invalidCredentials, 401)
  }

  const users = await User.findAll({ where: { email } })
  if (users.length === 0) {
    throw new AppError(errors.invalidCredentials, 401)
  }

  let user
  if (users.length === 1 && !companyId) {
    user = users[0]
  } else {
    if (!companyId) {
      throw new AppError(errors.companyRequired, 400)
    }
    user = users.find((row) => row.companyId === companyId)
    if (!user) {
      throw new AppError(errors.invalidCredentials, 401)
    }
  }

  const matches = await checkPassword(password, user.passwordHash)
  if (!matches) {
    throw new AppError(errors.invalidCredentials, 401)
  }
  if (!user.emailVerified) {
    throw new AppError(errors.emailNotVerified, 403)
  }
  if (user.status === userStatuses.disabled) {
    throw new AppError(errors.accountDisabled, 403)
  }
  if (user.status !== userStatuses.active) {
    throw new AppError(errors.invalidCredentials, 401)
  }

  const company = await Company.findByPk(user.companyId)
  if (!company || company.status === companyStatuses.disabled) {
    throw new AppError(errors.companyDisabled, 403)
  }
  if (company.status !== companyStatuses.active) {
    throw new AppError(errors.companyPending, 403)
  }

  const role = await Role.findByPk(user.roleId)
  if (!role || role.companyId !== user.companyId) {
    throw new AppError(errors.invalidCredentials, 401)
  }

  const tokens = await createSession(user, meta)
  user.lastLoginAt = new Date()
  await user.save()

  return {
    message: messages.loginOk,
    user: presentUser(user, role, company),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  }
}

async function refresh(body, meta = {}) {
  const refreshToken = readText(body, 'refreshToken')
  if (!refreshToken) {
    throw new AppError(errors.refreshInvalid, 401)
  }
  const tokens = await rotateRefreshToken(refreshToken, meta)
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  }
}

async function logout(body) {
  const refreshToken = readText(body, 'refreshToken')
  if (refreshToken) {
    await revokeRefreshToken(refreshToken)
  }
  return { message: messages.logoutOk }
}

async function logoutAll(userId) {
  await revokeAllUserSessions(userId)
  return { message: messages.logoutAllOk }
}

async function me(auth) {
  const { Company, User, Role } = getModels()
  const user = await User.findByPk(auth.userId)
  if (!user || user.companyId !== auth.companyId) {
    throw new AppError(errors.unauthorized, 401)
  }
  const company = await Company.findByPk(user.companyId)
  const role = await Role.findByPk(user.roleId)
  return { user: presentUser(user, role, company) }
}

async function forgotPassword(body) {
  const { Company, User } = getModels()
  const email = normalizeEmail(readText(body, 'email'))
  const companyId = readText(body, 'companyId')
  if (!email || !isEmail(email)) {
    return { message: messages.resetEmailSent }
  }
  const where = { email }
  if (companyId) {
    where.companyId = companyId
  }
  const user = await User.findOne({ where })
  if (!user) {
    return { message: messages.resetEmailSent }
  }
  const company = await Company.findByPk(user.companyId)
  const token = createSecretToken()
  user.resetTokenHash = hashSecret(token)
  user.resetExpiresAt = addHours(new Date(), security.resetHours)
  await user.save()
  try {
    await sendPasswordResetEmail({
      to: user.email,
      recipientName: user.name,
      token,
    })
  } catch (error) {
    // Still return generic message to avoid account enumeration.
  }
  return {
    message: messages.resetEmailSent,
    companyName: company ? company.name : undefined,
  }
}

async function resetPassword(body) {
  const { User } = getModels()
  const token = readText(body, 'token')
  const password = readPassword(body)
  const confirmPassword = readConfirmPassword(body)
  if (!token) {
    throw new AppError(errors.resetTokenInvalid, 400)
  }
  requirePassword(password)
  if (!confirmPassword) {
    throw new AppError(errors.confirmPasswordRequired, 400)
  }
  if (confirmPassword !== password) {
    throw new AppError(errors.passwordMismatch, 400)
  }
  const user = await User.findOne({
    where: { resetTokenHash: hashSecret(token) },
  })
  if (!user) {
    throw new AppError(errors.resetTokenInvalid, 400)
  }
  if (!user.resetExpiresAt || user.resetExpiresAt.getTime() < Date.now()) {
    throw new AppError(errors.resetTokenExpired, 400)
  }
  user.passwordHash = await hashPassword(password)
  user.resetTokenHash = null
  user.resetExpiresAt = null
  await user.save()
  await revokeAllUserSessions(user.id)
  return { message: messages.passwordUpdated }
}

module.exports = {
  registerCompany,
  verifyEmail,
  resendVerification,
  listCompaniesForEmail,
  login,
  refresh,
  logout,
  logoutAll,
  me,
  forgotPassword,
  resetPassword,
  presentUser,
}
