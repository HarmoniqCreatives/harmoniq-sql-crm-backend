'use strict'

const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const { getRecycleBin, postRecycleBinRestore } = require('./recycleBinController')

/**
 * Recycle Bin APIs — Super Admin / Admin via recycle_bin.view|restore.
 * Backend enforces company isolation and permissions (not frontend-only).
 */
const recycleBinRouter = express.Router()

recycleBinRouter.use(requireAuth)

recycleBinRouter.get(
  '/',
  requirePermission(permissionKeys.recycleBinView),
  asyncHandler(getRecycleBin),
)

recycleBinRouter.post(
  '/:entity/:id/restore',
  requirePermission(permissionKeys.recycleBinRestore),
  asyncHandler(postRecycleBinRestore),
)

module.exports = { recycleBinRouter }
