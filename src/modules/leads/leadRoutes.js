const express = require('express')
const { requireAuth, requirePermission } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const { permissionKeys } = require('../../utils/enums')
const { AppError, errors } = require('../../utils/errors')
const {
  getLeads,
  getLeadsExport,
  getLeadPageTypes,
  getOneLead,
  patchLead,
  patchLeadAssignment,
  postLead,
  postLeadsBulkAssign,
  postLeadsBulkDelete,
  postLeadsBulkTransfer,
  removeLead,
} = require('./leadController')
const {
  uploadImportFile,
  getLeadImportTemplate,
  postLeadImportSession,
  postLeadImportValidate,
  postLeadImportConfirm,
  getLeadImportSession,
  getLeadImportErrors,
} = require('./leadImportController')

/**
 * Lead routes. `companyId` from `requireAuth` only.
 * Soft-deleted leads are excluded by the service/model (paranoid).
 * Static paths (`/export`, `/import/*`, `/page-types`, `/bulk/*`) must stay above `/:id`.
 */
const leadRouter = express.Router()

leadRouter.use(requireAuth)

leadRouter.get('/', requirePermission(permissionKeys.leadsView), asyncHandler(getLeads))
leadRouter.get('/export', requirePermission(permissionKeys.leadsBulk), asyncHandler(getLeadsExport))
leadRouter.get('/page-types', requirePermission(permissionKeys.leadsView), asyncHandler(getLeadPageTypes))
leadRouter.get(
  '/import/template',
  requirePermission(permissionKeys.leadsImport),
  asyncHandler(getLeadImportTemplate),
)
leadRouter.post(
  '/import/sessions',
  requirePermission(permissionKeys.leadsImport),
  (req, res, next) => {
    uploadImportFile(req, res, (error) => {
      if (!error) {
        next()
        return
      }
      if (error instanceof AppError) {
        next(error)
        return
      }
      if (error && error.code === 'LIMIT_FILE_SIZE') {
        next(new AppError(errors.leadImportFileTooLarge, 400))
        return
      }
      next(new AppError(errors.leadImportFileRequired, 400))
    })
  },
  asyncHandler(postLeadImportSession),
)
leadRouter.post(
  '/import/sessions/:id/validate',
  requirePermission(permissionKeys.leadsImport),
  asyncHandler(postLeadImportValidate),
)
leadRouter.post(
  '/import/sessions/:id/confirm',
  requirePermission(permissionKeys.leadsImport),
  asyncHandler(postLeadImportConfirm),
)
leadRouter.get(
  '/import/sessions/:id/errors.xlsx',
  requirePermission(permissionKeys.leadsImport),
  asyncHandler(getLeadImportErrors),
)
leadRouter.get(
  '/import/sessions/:id',
  requirePermission(permissionKeys.leadsImport),
  asyncHandler(getLeadImportSession),
)
leadRouter.post('/', requirePermission(permissionKeys.leadsCreate), asyncHandler(postLead))
leadRouter.post('/bulk/assign', requirePermission(permissionKeys.leadsBulkAssign), asyncHandler(postLeadsBulkAssign))
leadRouter.post('/bulk/transfer', requirePermission(permissionKeys.leadsBulkTransfer), asyncHandler(postLeadsBulkTransfer))
leadRouter.post('/bulk/delete', requirePermission(permissionKeys.leadsBulkDelete), asyncHandler(postLeadsBulkDelete))
leadRouter.get('/:id', requirePermission(permissionKeys.leadsView), asyncHandler(getOneLead))
leadRouter.patch('/:id/assignment', requirePermission(permissionKeys.leadsAssign), asyncHandler(patchLeadAssignment))
leadRouter.patch('/:id', requirePermission(permissionKeys.leadsEdit), asyncHandler(patchLead))
leadRouter.delete('/:id', requirePermission(permissionKeys.leadsDelete), asyncHandler(removeLead))

module.exports = { leadRouter }
