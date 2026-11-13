const {
  assignLead,
  createLead,
  deleteLead,
  getLead,
  listLeads,
  updateLead,
} = require('../../services/leadService')

/** GET /api/leads */
async function getLeads(req, res) {
  const result = await listLeads(req.auth, req.query)
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

/** DELETE /api/leads/:id */
async function removeLead(req, res) {
  const result = await deleteLead(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

module.exports = {
  getLeads,
  getOneLead,
  postLead,
  patchLead,
  patchLeadAssignment,
  removeLead,
}
