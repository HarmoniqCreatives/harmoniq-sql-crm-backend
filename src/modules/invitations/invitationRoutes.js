const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const {
  inviteAcceptLimiter,
  inviteCreateLimiter,
  inviteResendLimiter,
} = require('../../middleware/rateLimit')
const { permissionKeys } = require('../../utils/enums')
const {
  getAcceptInvitation,
  getInvitations,
  patchInvitation,
  postAcceptInvitation,
  postInvitation,
  postInvitationLink,
  postResendInvitation,
  postRevokeInvitation,
} = require('./invitationController')

/**
 * Invitation HTTP routes.
 *
 * Public accept endpoints are rate-limited per IP + token prefix.
 * Authenticated routes require `users.invite` and are tenant-scoped in the service layer.
 *
 * | Method | Path | Permission |
 * | --- | --- | --- |
 * | GET | /accept | public |
 * | POST | /accept | public |
 * | GET | / | users.invite |
 * | POST | / | users.invite |
 * | POST | /:id/resend | users.invite |
 * | POST | /:id/revoke | users.invite |
 * | POST | /:id/link | users.invite (no mail) |
 */
const invitationRouter = express.Router()

invitationRouter.get(
  '/accept',
  inviteAcceptLimiter,
  asyncHandler(getAcceptInvitation),
)
invitationRouter.post(
  '/accept',
  inviteAcceptLimiter,
  asyncHandler(postAcceptInvitation),
)

invitationRouter.use(requireAuth)
invitationRouter.get('/', requirePermission(permissionKeys.usersInvite), asyncHandler(getInvitations))
invitationRouter.post('/', requirePermission(permissionKeys.usersInvite), inviteCreateLimiter, asyncHandler(postInvitation))
invitationRouter.post('/:id/resend', requirePermission(permissionKeys.usersInvite), inviteResendLimiter, asyncHandler(postResendInvitation))
invitationRouter.post('/:id/revoke', requirePermission(permissionKeys.usersInvite), asyncHandler(postRevokeInvitation))
invitationRouter.post('/:id/link', requirePermission(permissionKeys.usersInvite), asyncHandler(postInvitationLink))
invitationRouter.patch('/:id', requirePermission(permissionKeys.usersInvite), asyncHandler(patchInvitation))

module.exports = { invitationRouter }
