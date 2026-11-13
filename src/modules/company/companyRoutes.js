const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const { getCompanyRecord, patchCompanyRecord } = require('./companyController')

/**
 * Company defaults routes (timezone / base currency).
 * GET is available to any signed-in user; PATCH requires settings.manage.
 */
const companyRouter = express.Router()

companyRouter.use(requireAuth)
companyRouter.get('/', asyncHandler(getCompanyRecord))
companyRouter.patch('/', requirePermission(permissionKeys.settingsManage), asyncHandler(patchCompanyRecord))

module.exports = { companyRouter }
