const {
  assignLead,
  bulkAssignLeads,
  bulkDeleteLeads,
  bulkTransferLeads,
  createLead,
  deleteLead,
  getLead,
  listLeads,
  updateLead,
} = require('../../services/leadService')
const {
  exportLeads,
  listLeadPageTypes,
} = require('../../services/leadExportService')

/** GET /api/leads */
async function getLeads(req, res) {
  const result = await listLeads(req.auth, req.query)
  res.status(200).json({ data: result })
}

/** GET /api/leads/export — CSV/XLSX of all matching leads (no pagination). */
async function getLeadsExport(req, res) {
  const result = await exportLeads(req.auth, req.query)
  res.setHeader('Content-Type', result.contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
  res.status(200).send(result.body)
}

/** GET /api/leads/page-types */
async function getLeadPageTypes(req, res) {
  const result = await listLeadPageTypes(req.auth)
  res.status(200).json({ data: result })
}

/** GET /api/leads/:id */
async function getOneLead(req, res) {
  const result = await getLead(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

/** POST /api/leads */
async function postLead(req, res) {
  const result = await createLead(req.auth, req.body)
  res.status(201).json({ data: result })
}

/** PATCH /api/leads/:id */
async function patchLead(req, res) {
  const result = await updateLead(req.auth, req.params.id, req.body)
  res.status(200).json({ data: result })
}

/** PATCH /api/leads/:id/assignment */
async function patchLeadAssignment(req, res) {
  const result = await assignLead(req.auth, req.params.id, req.body)
  res.status(200).json({ data: result })
}

/** POST /api/leads/bulk/assign */
async function postLeadsBulkAssign(req, res) {
  const result = await bulkAssignLeads(req.auth, req.body)
  res.status(200).json({ data: result })
}

/** POST /api/leads/bulk/transfer */
async function postLeadsBulkTransfer(req, res) {
  const result = await bulkTransferLeads(req.auth, req.body)
  res.status(200).json({ data: result })
}

/** POST /api/leads/bulk/delete */
async function postLeadsBulkDelete(req, res) {
  const result = await bulkDeleteLeads(req.auth, req.body)
  res.status(200).json({ data: result })
}

/** DELETE /api/leads/:id */
async function removeLead(req, res) {
  const result = await deleteLead(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

module.exports = {
  getLeads,
  getLeadsExport,
  getLeadPageTypes,
  getOneLead,
  postLead,
  patchLead,
  patchLeadAssignment,
  postLeadsBulkAssign,
  postLeadsBulkTransfer,
  postLeadsBulkDelete,
  removeLead,
}
