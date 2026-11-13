const {
  acceptInvitation,
  createInvitation,
  issueInvitationLink,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
  updateInvitation,
} = require('../../services/invitationService')
const { resolvePublicFrontendBase } = require('../../services/mailService')
const { readText } = require('../../utils/helpers')
const { messages } = require('../../utils/messages')

/**
 * GET /api/invitations — lists company invitations (`users.invite`).
 */
async function getInvitations(req, res) {
  const result = await listInvitations(req.auth)
  res.status(200).json({ data: result })
}

/**
 * POST /api/invitations — creates invite; body: name, email, roleId, branchId?, teamId?.
 * Responds 201 quickly; email delivery is asynchronous.
 */
async function postInvitation(req, res) {
  const publicFrontendBase = resolvePublicFrontendBase(req)
  const result = await createInvitation(req.auth, req.body, publicFrontendBase, null)
  let message = messages.invitationCreated
  if (result.emailDelivery === messages.emailDeliveryFailed) {
    message = messages.invitationCreatedEmailFailed
  }
  res.status(201).json({
    data: {
      message,
      emailDelivery: result.emailDelivery,
      link: result.link,
      invitationUrl: result.invitationUrl,
      expiresAt: result.expiresAt,
      invitation: result.invitation,
    },
  })
}

/**
 * POST /api/invitations/:id/resend — rotates token and queues email.
 */
async function postResendInvitation(req, res) {
  const publicFrontendBase = resolvePublicFrontendBase(req)
  const result = await resendInvitation(req.auth, req.params.id, publicFrontendBase, null)
  res.status(200).json({ data: result })
}

/**
 * POST /api/invitations/:id/revoke — invalidates a pending invite.
 */
async function postRevokeInvitation(req, res) {
  const result = await revokeInvitation(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

/**
 * POST /api/invitations/:id/link — returns `{ link, expiresAt }` without sending mail.
 */
async function postInvitationLink(req, res) {
  const publicFrontendBase = resolvePublicFrontendBase(req)
  const result = await issueInvitationLink(req.auth, req.params.id, publicFrontendBase)
  res.status(200).json({
    data: {
      message: result.message,
      link: result.link,
      expiresAt: result.expiresAt,
      invitationUrl: result.invitationUrl,
      invitation: result.invitation,
    },
  })
}

/**
 * GET /api/invitations/accept?token= — public preview for the accept page.
 */
async function getAcceptInvitation(req, res) {
  const result = await previewInvitation(readText(req.query, 'token'))
  res.status(200).json({ data: result })
}

/**
 * POST /api/invitations/accept — body: token, password, confirmPassword.
 */
async function postAcceptInvitation(req, res) {
  const result = await acceptInvitation(req.body)
  res.status(200).json({ data: result })
}

/**
 * PATCH /api/invitations/:id — edit pending invitation fields without rotating token.
 */
async function patchInvitation(req, res) {
  const result = await updateInvitation(req.auth, req.params.id, req.body)
  res.status(200).json({ data: result })
}

module.exports = {
  getInvitations,
  postInvitation,
  postResendInvitation,
  postRevokeInvitation,
  postInvitationLink,
  getAcceptInvitation,
  postAcceptInvitation,
  patchInvitation,
}
