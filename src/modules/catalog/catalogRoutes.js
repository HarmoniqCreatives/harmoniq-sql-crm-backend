const express = require('express')
const { requireAuth, requireAnyPermission, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const {
  getCatalog,
  patchCatalogItem,
  postCatalogItem,
  removeCatalogItem,
} = require('./catalogController')

/**
 * Catalog routes (status / tag / activity).
 * GET is shared with leads.view so lead UIs can load active chips without settings.manage.
 */
const catalogRouter = express.Router()

catalogRouter.use(requireAuth)

catalogRouter.get(
  '/',
  requireAnyPermission([permissionKeys.settingsManage, permissionKeys.leadsView]),
  asyncHandler(getCatalog),
)
catalogRouter.post('/', requirePermission(permissionKeys.settingsManage), asyncHandler(postCatalogItem))
catalogRouter.patch('/:id', requirePermission(permissionKeys.settingsManage), asyncHandler(patchCatalogItem))
catalogRouter.delete('/:id', requirePermission(permissionKeys.settingsManage), asyncHandler(removeCatalogItem))

module.exports = { catalogRouter }
