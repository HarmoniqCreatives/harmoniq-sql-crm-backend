const express = require('express')
const { requireAuth, requireAnyPermission, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const {
  getPermissions,
  getRoleById,
  getRoles,
  patchRole,
  postRole,
  removeRole,
} = require('./roleController')

/**
 * Role and permission-matrix routes.
 * GET / is shared with users.view / users.invite so invite UIs can load assignable roles.
 */
const roleRouter = express.Router()

roleRouter.use(requireAuth)

roleRouter.get(
  '/',
  requireAnyPermission([permissionKeys.rolesView, permissionKeys.usersView, permissionKeys.usersInvite]),
  asyncHandler(getRoles),
)
roleRouter.get('/permissions', requirePermission(permissionKeys.rolesView), asyncHandler(getPermissions))
roleRouter.get('/:id', requirePermission(permissionKeys.rolesView), asyncHandler(getRoleById))
roleRouter.post('/', requirePermission(permissionKeys.rolesCreate), asyncHandler(postRole))
roleRouter.patch('/:id', requirePermission(permissionKeys.rolesEdit), asyncHandler(patchRole))
roleRouter.delete('/:id', requirePermission(permissionKeys.rolesDelete), asyncHandler(removeRole))

module.exports = { roleRouter }
