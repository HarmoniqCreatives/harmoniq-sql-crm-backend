'use strict'

const { listDeletedLeads, restoreLead } = require('../../services/leadService')
const { listDeletedRoles, restoreRole } = require('../../services/roleService')
const { listDeletedCatalogItems, restoreCatalogItem } = require('../../services/catalogService')
const { listDeletedProfiles, restoreProfile } = require('../../services/metaService')
const {
  listDeletedEmailReports,
  restoreEmailReport,
} = require('../../services/emailReportService')
const { messages } = require('../../utils/messages')
const { AppError } = require('../../utils/errors')

const ENTITY_TYPES = new Set([
  'leads',
  'roles',
  'catalog',
  'meta_profiles',
  'email_reports',
])

/**
 * GET /api/recycle-bin?entity=
 * Lists soft-deleted records for one entity type (company-scoped).
 */
async function getRecycleBin(req, res) {
  const entity = String(req.query.entity || 'leads').trim()
  if (!ENTITY_TYPES.has(entity)) {
    throw new AppError('Unknown recycle bin entity type.', 400)
  }
  if (entity === 'leads') {
    const result = await listDeletedLeads(req.auth, req.query)
    res.status(200).json({ data: { entity, ...result } })
    return
  }
  if (entity === 'roles') {
    const roles = await listDeletedRoles(req.auth)
    res.status(200).json({ data: { entity, roles } })
    return
  }
  if (entity === 'catalog') {
    const items = await listDeletedCatalogItems(req.auth, req.query)
    res.status(200).json({ data: { entity, items } })
    return
  }
  if (entity === 'meta_profiles') {
    const profiles = await listDeletedProfiles(req.auth)
    res.status(200).json({ data: { entity, profiles } })
    return
  }
  const reports = await listDeletedEmailReports(req.auth)
  res.status(200).json({ data: { entity, reports } })
}

/**
 * POST /api/recycle-bin/:entity/:id/restore
 */
async function postRecycleBinRestore(req, res) {
  const entity = String(req.params.entity || '').trim()
  const id = req.params.id
  if (!ENTITY_TYPES.has(entity)) {
    throw new AppError('Unknown recycle bin entity type.', 400)
  }
  if (entity === 'leads') {
    const result = await restoreLead(req.auth, id)
    res.status(200).json({ data: result })
    return
  }
  if (entity === 'roles') {
    const result = await restoreRole(req.auth, id)
    res.status(200).json({ data: result })
    return
  }
  if (entity === 'catalog') {
    const item = await restoreCatalogItem(req.auth, id)
    res.status(200).json({ data: { message: messages.catalogRestored, item } })
    return
  }
  if (entity === 'meta_profiles') {
    const profile = await restoreProfile(req.auth, id)
    res.status(200).json({ data: { message: messages.metaProfileRestored, profile } })
    return
  }
  const result = await restoreEmailReport(req.auth, id)
  res.status(200).json({ data: result })
}

module.exports = {
  getRecycleBin,
  postRecycleBinRestore,
  ENTITY_TYPES,
}
