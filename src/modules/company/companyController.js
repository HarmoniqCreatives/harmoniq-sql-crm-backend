const { getCompany, updateCompany } = require('../../services/companyService')
const {
  createEmailReport,
  deleteEmailReport,
  setEmailReportsEnabled,
  updateEmailReport,
} = require('../../services/emailReportService')
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

/** PATCH /api/company/email-reports/enabled */
async function patchEmailReportsEnabled(req, res) {
  const emailReports = await setEmailReportsEnabled(req.auth, Boolean(req.body && req.body.enabled))
  res.status(200).json({
    data: {
      message: messages.emailReportsEnabledUpdated,
      emailReports,
    },
  })
}

/** POST /api/company/email-reports */
async function postEmailReport(req, res) {
  const result = await createEmailReport(req.auth, req.body || {})
  res.status(201).json({
    data: {
      message: messages.emailReportCreated,
      ...result,
    },
  })
}

/** PATCH /api/company/email-reports/:id */
async function patchEmailReport(req, res) {
  const result = await updateEmailReport(req.auth, req.params.id, req.body || {})
  res.status(200).json({
    data: {
      message: messages.emailReportUpdated,
      ...result,
    },
  })
}

/** DELETE /api/company/email-reports/:id */
async function removeEmailReport(req, res) {
  const emailReports = await deleteEmailReport(req.auth, req.params.id)
  res.status(200).json({
    data: {
      message: messages.emailReportDeleted,
      emailReports,
    },
  })
}

module.exports = {
  getCompanyRecord,
  patchCompanyRecord,
  patchEmailReportsEnabled,
  postEmailReport,
  patchEmailReport,
  removeEmailReport,
}
