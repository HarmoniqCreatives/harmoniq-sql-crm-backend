const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const {
  getLeads,
  getLeadsExport,
  getLeadPageTypes,
  getOneLead,
  patchLead,
  patchLeadAssignment,
  postLead,
  removeLead,
} = require('./leadController')

/**
 * Lead routes. `companyId` from `requireAuth` only.
 * Soft-deleted leads are excluded by the service/model (paranoid).
 * Static paths (`/export`, `/page-types`) must stay above `/:id`.
 */
const leadRouter = express.Router()

leadRouter.use(requireAuth)

leadRouter.get('/', requirePermission(permissionKeys.leadsView), asyncHandler(getLeads))
leadRouter.get('/export', requirePermission(permissionKeys.leadsBulk), asyncHandler(getLeadsExport))
leadRouter.get('/page-types', requirePermission(permissionKeys.leadsView), asyncHandler(getLeadPageTypes))
leadRouter.post('/', requirePermission(permissionKeys.leadsCreate), asyncHandler(postLead))
leadRouter.get('/:id', requirePermission(permissionKeys.leadsView), asyncHandler(getOneLead))
leadRouter.patch('/:id/assignment', requirePermission(permissionKeys.leadsAssign), asyncHandler(patchLeadAssignment))
leadRouter.patch('/:id', requirePermission(permissionKeys.leadsEdit), asyncHandler(patchLead))
leadRouter.delete('/:id', requirePermission(permissionKeys.leadsDelete), asyncHandler(removeLead))

module.exports = { leadRouter }
