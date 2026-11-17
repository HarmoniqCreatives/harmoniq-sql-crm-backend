const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const {
  getCompanyRecord,
  patchCompanyRecord,
  patchEmailReportsEnabled,
  postEmailReport,
  patchEmailReport,
  removeEmailReport,
} = require('./companyController')

/**
 * Company defaults + Automatic Email Reports schedules.
 * GET is available to any signed-in user; mutations require settings.manage.
 */
const companyRouter = express.Router()

companyRouter.use(requireAuth)
companyRouter.get('/', asyncHandler(getCompanyRecord))
companyRouter.patch('/', requirePermission(permissionKeys.settingsManage), asyncHandler(patchCompanyRecord))

companyRouter.patch(
  '/email-reports/enabled',
  requirePermission(permissionKeys.settingsManage),
  asyncHandler(patchEmailReportsEnabled),
)
companyRouter.post(
  '/email-reports',
  requirePermission(permissionKeys.settingsManage),
  asyncHandler(postEmailReport),
)
companyRouter.patch(
  '/email-reports/:id',
  requirePermission(permissionKeys.settingsManage),
  asyncHandler(patchEmailReport),
)
companyRouter.delete(
  '/email-reports/:id',
  requirePermission(permissionKeys.settingsManage),
  asyncHandler(removeEmailReport),
)

module.exports = { companyRouter }
