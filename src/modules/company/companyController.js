const { getCompany, updateCompany } = require('../../services/companyService')
const { messages } = require('../../utils/messages')

/** GET /api/company — any authenticated member of the tenant. */
async function getCompanyRecord(req, res) {
  const company = await getCompany(req.auth)
  res.status(200).json({ data: { company } })
}

/** PATCH /api/company — timezone + baseCurrency (`settings.manage`). */
async function patchCompanyRecord(req, res) {
  const company = await updateCompany(req.auth, req.body)
  res.status(200).json({
    data: {
      message: messages.companyUpdated,
      company,
    },
  })
}

module.exports = {
  getCompanyRecord,
  patchCompanyRecord,
}
