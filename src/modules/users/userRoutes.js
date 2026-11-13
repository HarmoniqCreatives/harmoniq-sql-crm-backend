const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const {
  getBranches,
  getTeams,
  getUserById,
  getUsers,
  patchUser,
  postActivateUser,
  postDeactivateUser,
  postPasswordReset,
  postUser,
} = require('./userController')

/**
 * User directory routes. `companyId` is taken only from `requireAuth`.
 *
 * Errors: 401 unauthenticated, 403 missing permission, 404 other-tenant or missing user.
 */
const userRouter = express.Router()

userRouter.use(requireAuth)

userRouter.get('/', requirePermission(permissionKeys.usersView), asyncHandler(getUsers))
userRouter.get('/branches', requirePermission(permissionKeys.usersView), asyncHandler(getBranches))
userRouter.get('/teams', requirePermission(permissionKeys.usersView), asyncHandler(getTeams))
userRouter.get('/:id', requirePermission(permissionKeys.usersView), asyncHandler(getUserById))
userRouter.post('/', requirePermission(permissionKeys.usersCreate), asyncHandler(postUser))
userRouter.patch('/:id', requirePermission(permissionKeys.usersEdit), asyncHandler(patchUser))
userRouter.post('/:id/activate', requirePermission(permissionKeys.usersEdit), asyncHandler(postActivateUser))
userRouter.post('/:id/deactivate', requirePermission(permissionKeys.usersDelete), asyncHandler(postDeactivateUser))
userRouter.post('/:id/password-reset', requirePermission(permissionKeys.usersEdit), asyncHandler(postPasswordReset))

module.exports = { userRouter }
