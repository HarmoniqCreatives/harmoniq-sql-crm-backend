const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { security } = require('../config/security')
const { getModels } = require('../models')
const {
  emailDeliveryStatuses,
  invitationStatuses,
  userStatuses,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { messages } = require('../utils/messages')
const {
  addHours,
  createSecretToken,
  hashPassword,
  hashSecret,
  isEmail,
  isWithinLength,
  normalizeEmail,
  readText,
  requirePassword,
} = require('../utils/helpers')
const {
  assertCanAssignRole,
  loadCompanyBranch,
  loadCompanyRole,
  loadCompanyTeam,
} = require('./accessService')
const {
  acceptInvitationLink,
  sendInvitationEmail,
  shortMailError,
} = require('./mailService')

/**
 * Invitation workflows for a single company tenant.
 *
 * Business rules: hashed tokens only, 24h expiry, single-use accept in a
 * transaction, duplicate pending/active blocked, copy-link never sends mail,
 * create/resend return before background email finishes.
 */

/**
 * Safe invitation DTO (never includes tokenHash or raw tokens).
 *
 * @param {object} invitation
 * @param {object} [extras]
 * @returns {object}
 */
function presentInvitation(invitation, extras = {}) {
  const role = extras.role || invitation.Role || null
  const branch = extras.branch || invitation.Branch || null
  const team = extras.team || invitation.Team || null
  return {
    id: invitation.id,
    name: invitation.name,
    email: invitation.email,
    status: invitation.status,
    emailDelivery: invitation.emailDelivery || null,
    emailError: invitation.emailError || null,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    createdAt: invitation.createdAt,
    role: role ? { id: role.id, key: role.key, name: role.name } : null,
    branch: branch ? { id: branch.id, name: branch.name } : null,
    team: team ? { id: team.id, name: team.name } : null,
  }
}

/**
 * Persists short mail outcome fields without secrets.
 *
 * @param {string} invitationId
 * @param {string} emailDelivery pending|sent|failed
 * @param {string} [emailError]
 * @returns {Promise<void>}
 */
async function setInvitationEmailDelivery(invitationId, emailDelivery, emailError) {
  const { Invitation } = getModels()
  if (emailError) {
    await Invitation.update(
      { emailDelivery, emailError: String(emailError).slice(0, 80) },
      { where: { id: invitationId } },
    )
    return
  }
  await Invitation.update(
    { emailDelivery, emailError: null },
    { where: { id: invitationId } },
  )
}

/**
 * Fires invitation email off the request path so SMTP/Resend timeouts cannot block APIs.
 *
 * @param {object} auth
 * @param {object} invitation
 * @param {object} role
 * @param {string} token raw token (never logged)
 * @param {string} publicFrontendBase
 */
function queueInvitationEmail(auth, invitation, role, token, publicFrontendBase) {
  setImmediate(() => {
    sendInvitationEmail({
      to: invitation.email,
      recipientName: invitation.name,
      inviterName: auth.user.name,
      companyName: auth.company.name,
      roleName: role.name,
      token,
      frontendBase: publicFrontendBase,
    })
      .then(() => setInvitationEmailDelivery(invitation.id, emailDeliveryStatuses.sent))
      .catch((error) => setInvitationEmailDelivery(
        invitation.id,
        emailDeliveryStatuses.failed,
        shortMailError(error),
      ))
      .catch(() => null)
  })
}

/**
 * Lists invitations for the authenticated company only.
 *
 * @param {{ companyId: string }} auth
 * @returns {Promise<{ invitations: object[] }>}
 */
async function listInvitations(auth) {
  const { Invitation, Role, Branch, Team } = getModels()
  const rows = await Invitation.findAll({
    where: { companyId: auth.companyId },
    include: [
      { model: Role, attributes: ['id', 'key', 'name'] },
      { model: Branch, attributes: ['id', 'name'] },
      { model: Team, attributes: ['id', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
  })
  return { invitations: rows.map((row) => presentInvitation(row)) }
}

/**
 * Creates a pending invitation after validating role/branch/team ownership.
 *
 * Blocks duplicate active users and duplicate pending invites in the company.
 * Returns immediately with a copyable link; email runs in the background unless
 * a test `mailer` is injected.
 *
 * @param {object} auth authenticated company context
 * @param {object} body name, email, roleId, branchId?, teamId?
 * @param {string} publicFrontendBase APP_BASE_URL-derived origin
 * @param {Function|null} [mailer] optional sync mailer for tests
 * @returns {Promise<object>}
 */
async function createInvitation(auth, body, publicFrontendBase, mailer) {
  const { Invitation, User } = getModels()
  const name = readText(body, 'name')
  const email = normalizeEmail(readText(body, 'email'))
  const roleId = readText(body, 'roleId')
  const branchId = readText(body, 'branchId') || null
  const teamId = readText(body, 'teamId') || null

  if (!name || !isWithinLength(name, security.nameMaxLength)) {
    throw new AppError(errors.nameRequired, 400)
  }
  if (!email || !isEmail(email)) {
    throw new AppError(errors.emailInvalid, 400)
  }
  if (!roleId) {
    throw new AppError(errors.roleNotFound, 400)
  }

  const existingUser = await User.findOne({
    where: {
      companyId: auth.companyId,
      email,
      status: { [Op.ne]: userStatuses.disabled },
    },
  })
  if (existingUser) {
    throw new AppError(errors.emailTaken, 409)
  }

  const pending = await Invitation.findOne({
    where: {
      companyId: auth.companyId,
      email,
      status: invitationStatuses.pending,
    },
  })
  if (pending) {
    throw new AppError(errors.invitationPending, 409)
  }

  const role = await loadCompanyRole(auth.companyId, roleId)
  assertCanAssignRole(auth, role)
  const branch = await loadCompanyBranch(auth.companyId, branchId)
  const team = await loadCompanyTeam(auth.companyId, teamId, branch ? branch.id : branchId)

  const token = createSecretToken()
  const invitation = await Invitation.create({
    id: uuidv4(),
    companyId: auth.companyId,
    email,
    name,
    roleId: role.id,
    branchId: branch ? branch.id : null,
    teamId: team ? team.id : null,
    tokenHash: hashSecret(token),
    expiresAt: addHours(new Date(), security.invitationHours || 24),
    invitedBy: auth.userId,
    status: invitationStatuses.pending,
    emailDelivery: emailDeliveryStatuses.pending,
  })

  const link = acceptInvitationLink(token, publicFrontendBase)
  if (mailer) {
    try {
      await mailer({
        to: email,
        recipientName: name,
        inviterName: auth.user.name,
        companyName: auth.company.name,
        roleName: role.name,
        token,
        frontendBase: publicFrontendBase,
      })
      await setInvitationEmailDelivery(invitation.id, emailDeliveryStatuses.sent)
    } catch (error) {
      await setInvitationEmailDelivery(invitation.id, emailDeliveryStatuses.failed, shortMailError(error))
    }
  } else {
    queueInvitationEmail(auth, invitation, role, token, publicFrontendBase)
  }

  const stored = await Invitation.findByPk(invitation.id, {
    include: [
      { model: getModels().Role, attributes: ['id', 'key', 'name'] },
      { model: getModels().Branch, attributes: ['id', 'name'] },
      { model: getModels().Team, attributes: ['id', 'name'] },
    ],
  })

  return {
    message: messages.invitationCreated,
    invitation: presentInvitation(stored),
    link,
    invitationUrl: link,
    expiresAt: invitation.expiresAt,
    emailDelivery: stored.emailDelivery || emailDeliveryStatuses.pending,
  }
}

/**
 * Rotates the invite token, extends expiry, and queues a new email.
 * The previous raw token stops working because only the new hash is stored.
 *
 * @param {object} auth
 * @param {string} invitationId
 * @param {string} publicFrontendBase
 * @param {Function|null} [mailer]
 * @returns {Promise<object>}
 */
async function resendInvitation(auth, invitationId, publicFrontendBase, mailer) {
  const { Invitation, Role, Branch, Team } = getModels()
  const invitation = await Invitation.findOne({
    where: { id: invitationId, companyId: auth.companyId },
  })
  if (!invitation) {
    throw new AppError(errors.invitationNotFound, 404)
  }
  if (invitation.status !== invitationStatuses.pending) {
    throw new AppError(errors.invitationNotPending, 400)
  }
  const role = await loadCompanyRole(auth.companyId, invitation.roleId)
  assertCanAssignRole(auth, role)

  const token = createSecretToken()
  invitation.tokenHash = hashSecret(token)
  invitation.expiresAt = addHours(new Date(), security.invitationHours || 24)
  invitation.emailDelivery = emailDeliveryStatuses.pending
  invitation.emailError = null
  invitation.claimId = null
  await invitation.save()

  if (mailer) {
    try {
      await mailer({
        to: invitation.email,
        recipientName: invitation.name,
        inviterName: auth.user.name,
        companyName: auth.company.name,
        roleName: role.name,
        token,
        frontendBase: publicFrontendBase,
      })
      await setInvitationEmailDelivery(invitation.id, emailDeliveryStatuses.sent)
    } catch (error) {
      await setInvitationEmailDelivery(invitation.id, emailDeliveryStatuses.failed, shortMailError(error))
    }
  } else {
    queueInvitationEmail(auth, invitation, role, token, publicFrontendBase)
  }

  const stored = await Invitation.findByPk(invitation.id, {
    include: [
      { model: Role, attributes: ['id', 'key', 'name'] },
      { model: Branch, attributes: ['id', 'name'] },
      { model: Team, attributes: ['id', 'name'] },
    ],
  })
  const link = acceptInvitationLink(token, publicFrontendBase)
  return {
    message: messages.invitationResent,
    invitation: presentInvitation(stored),
    link,
    invitationUrl: link,
    expiresAt: invitation.expiresAt,
    emailDelivery: stored.emailDelivery,
  }
}

/**
 * Revokes a pending invitation and clears its token hash.
 *
 * @param {object} auth
 * @param {string} invitationId
 * @returns {Promise<object>}
 */
async function revokeInvitation(auth, invitationId) {
  const { Invitation, Role, Branch, Team } = getModels()
  const invitation = await Invitation.findOne({
    where: { id: invitationId, companyId: auth.companyId },
  })
  if (!invitation) {
    throw new AppError(errors.invitationNotFound, 404)
  }
  if (invitation.status !== invitationStatuses.pending) {
    throw new AppError(errors.invitationNotPending, 400)
  }
  invitation.status = invitationStatuses.revoked
  invitation.tokenHash = null
  invitation.claimId = null
  await invitation.save()
  const stored = await Invitation.findByPk(invitation.id, {
    include: [
      { model: Role, attributes: ['id', 'key', 'name'] },
      { model: Branch, attributes: ['id', 'name'] },
      { model: Team, attributes: ['id', 'name'] },
    ],
  })
  return {
    message: messages.invitationRevoked,
    invitation: presentInvitation(stored),
  }
}

/**
 * Issues a fresh accept link without calling the mail service.
 *
 * Required on Render where outbound SMTP times out. Rotates `tokenHash` only
 * and keeps the existing `expiresAt`.
 *
 * @param {object} auth
 * @param {string} invitationId
 * @param {string} publicFrontendBase
 * @returns {Promise<{ link: string, expiresAt: Date, invitation: object }>}
 */
async function issueInvitationLink(auth, invitationId, publicFrontendBase) {
  const { Invitation, Role, Branch, Team } = getModels()
  const invitation = await Invitation.findOne({
    where: { id: invitationId, companyId: auth.companyId },
  })
  if (!invitation) {
    throw new AppError(errors.invitationNotFound, 404)
  }
  if (invitation.status === invitationStatuses.accepted) {
    throw new AppError(errors.invitationUsed, 400)
  }
  if (invitation.status === invitationStatuses.expired) {
    throw new AppError(errors.invitationExpired, 400)
  }
  if (invitation.status === invitationStatuses.revoked) {
    throw new AppError(errors.invitationRevoked, 400)
  }
  if (invitation.status !== invitationStatuses.pending) {
    throw new AppError(errors.invitationNotCopyable, 400)
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    invitation.status = invitationStatuses.expired
    invitation.tokenHash = null
    await invitation.save()
    throw new AppError(errors.invitationExpired, 400)
  }

  const role = await loadCompanyRole(auth.companyId, invitation.roleId)
  assertCanAssignRole(auth, role)

  const token = createSecretToken()
  const expiresAt = invitation.expiresAt
  invitation.tokenHash = hashSecret(token)
  invitation.claimId = null
  await invitation.save()

  const stored = await Invitation.findByPk(invitation.id, {
    include: [
      { model: Role, attributes: ['id', 'key', 'name'] },
      { model: Branch, attributes: ['id', 'name'] },
      { model: Team, attributes: ['id', 'name'] },
    ],
  })
  const link = acceptInvitationLink(token, publicFrontendBase)
  return {
    message: messages.invitationLinkReady,
    invitation: presentInvitation(stored),
    link,
    invitationUrl: link,
    expiresAt,
  }
}

/**
 * Public preview for the accept page. Invalid/expired/used tokens share one message.
 *
 * @param {string} token raw invite token from the URL
 * @returns {Promise<{ invitation: object }>}
 */
async function previewInvitation(token) {
  const { Invitation, Company, Role } = getModels()
  if (!token) {
    throw new AppError(errors.invitationInvalid, 400)
  }
  const invitation = await Invitation.findOne({
    where: { tokenHash: hashSecret(token) },
  })
  if (!invitation || invitation.status !== invitationStatuses.pending) {
    throw new AppError(errors.invitationInvalid, 400)
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    invitation.status = invitationStatuses.expired
    invitation.tokenHash = null
    await invitation.save()
    throw new AppError(errors.invitationInvalid, 400)
  }
  const company = await Company.findByPk(invitation.companyId)
  const role = await Role.findByPk(invitation.roleId)
  return {
    invitation: {
      email: invitation.email,
      name: invitation.name,
      expiresAt: invitation.expiresAt,
      companyName: company ? company.name : '',
      roleName: role ? role.name : '',
    },
  }
}

/**
 * Accepts an invitation: hashes password, creates/activates the user, marks
 * the invitation accepted, and clears the token in one DB transaction.
 *
 * @param {object} body token, password, confirmPassword
 * @returns {Promise<{ message: string }>}
 */
async function acceptInvitation(body) {
  const { sequelize, Invitation, User, Role } = getModels()
  const token = readText(body, 'token')
  const password = typeof body.password === 'string' ? body.password : ''
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : ''
  if (!token) {
    throw new AppError(errors.invitationInvalid, 400)
  }
  requirePassword(password)
  if (!confirmPassword) {
    throw new AppError(errors.confirmPasswordRequired, 400)
  }
  if (confirmPassword !== password) {
    throw new AppError(errors.passwordMismatch, 400)
  }

  await sequelize.transaction(async (transaction) => {
    const invitation = await Invitation.findOne({
      where: { tokenHash: hashSecret(token) },
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
    if (!invitation || invitation.status !== invitationStatuses.pending) {
      throw new AppError(errors.invitationInvalid, 400)
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      invitation.status = invitationStatuses.expired
      invitation.tokenHash = null
      await invitation.save({ transaction })
      throw new AppError(errors.invitationInvalid, 400)
    }

    const role = await Role.findOne({
      where: { id: invitation.roleId, companyId: invitation.companyId },
      transaction,
    })
    if (!role) {
      throw new AppError(errors.invitationInvalid, 400)
    }

    let user = await User.findOne({
      where: { companyId: invitation.companyId, email: invitation.email },
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
    const passwordHash = await hashPassword(password)
    if (user) {
      user.name = invitation.name
      user.roleId = role.id
      user.branchId = invitation.branchId
      user.teamId = invitation.teamId
      user.passwordHash = passwordHash
      user.status = userStatuses.active
      user.emailVerified = true
      user.disabledAt = null
      await user.save({ transaction })
    } else {
      user = await User.create({
        id: uuidv4(),
        companyId: invitation.companyId,
        roleId: role.id,
        branchId: invitation.branchId,
        teamId: invitation.teamId,
        name: invitation.name,
        email: invitation.email,
        passwordHash,
        status: userStatuses.active,
        emailVerified: true,
        isInitialSuperAdmin: false,
      }, { transaction })
    }

    invitation.status = invitationStatuses.accepted
    invitation.acceptedAt = new Date()
    invitation.tokenHash = null
    invitation.claimId = null
    await invitation.save({ transaction })
  })

  return { message: messages.invitationAccepted }
}

/**
 * Updates a pending invitation's name, email, role, branch, or team without rotating the token.
 *
 * @param {object} auth
 * @param {string} invitationId
 * @param {object} body
 * @returns {Promise<{ message: string, invitation: object }>}
 */
async function updateInvitation(auth, invitationId, body) {
  const { Invitation, User, Role, Branch, Team } = getModels()
  const invitation = await Invitation.findOne({
    where: {
      id: invitationId,
      companyId: auth.companyId,
      status: invitationStatuses.pending,
    },
  })
  if (!invitation) {
    throw new AppError(errors.invitationNotPending, 400)
  }

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = readText(body, 'name')
    if (!name || !isWithinLength(name, security.nameMaxLength)) {
      throw new AppError(errors.nameRequired, 400)
    }
    invitation.name = name
  }

  if (Object.prototype.hasOwnProperty.call(body, 'email')) {
    const email = normalizeEmail(readText(body, 'email'))
    if (!email || !isEmail(email)) {
      throw new AppError(errors.emailInvalid, 400)
    }
    if (email !== invitation.email) {
      const existingUser = await User.findOne({
        where: { companyId: auth.companyId, email, status: { [Op.ne]: userStatuses.disabled } },
      })
      if (existingUser) {
        throw new AppError(errors.emailTaken, 409)
      }
      const existingInvite = await Invitation.findOne({
        where: { companyId: auth.companyId, email, status: invitationStatuses.pending },
      })
      if (existingInvite) {
        throw new AppError(errors.invitationPending, 409)
      }
      invitation.email = email
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'roleId')) {
    const roleId = readText(body, 'roleId')
    if (roleId !== invitation.roleId) {
      const role = await loadCompanyRole(auth.companyId, roleId)
      assertCanAssignRole(auth, role)
      invitation.roleId = role.id
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'branchId') || Object.prototype.hasOwnProperty.call(body, 'teamId')) {
    const branchId = Object.prototype.hasOwnProperty.call(body, 'branchId')
      ? (readText(body, 'branchId') || null)
      : invitation.branchId
    const teamId = Object.prototype.hasOwnProperty.call(body, 'teamId')
      ? (readText(body, 'teamId') || null)
      : invitation.teamId
    const branch = await loadCompanyBranch(auth.companyId, branchId)
    const team = await loadCompanyTeam(auth.companyId, teamId, branch ? branch.id : branchId)
    invitation.branchId = branch ? branch.id : null
    invitation.teamId = team ? team.id : null
  }

  await invitation.save()
  const stored = await Invitation.findByPk(invitation.id, {
    include: [
      { model: Role, attributes: ['id', 'key', 'name'] },
      { model: Branch, attributes: ['id', 'name'] },
      { model: Team, attributes: ['id', 'name'] },
    ],
  })
  return {
    message: messages.invitationUpdated,
    invitation: presentInvitation(stored),
  }
}

module.exports = {
  listInvitations,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  issueInvitationLink,
  previewInvitation,
  acceptInvitation,
  updateInvitation,
  presentInvitation,
}
