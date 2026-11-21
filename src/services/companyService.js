const { getModels } = require('../models')
const { currencies, timezones } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { readText } = require('../utils/helpers')
const { presentEmailReports } = require('./emailReportService')

function mergeEnabledCurrencies(companyEnabled) {
  const known = Object.values(currencies)
  const existing = Array.isArray(companyEnabled) ? companyEnabled : []
  const merged = []
  for (const code of [...existing, ...known]) {
    if (known.includes(code) && !merged.includes(code)) {
      merged.push(code)
    }
  }
  return merged
}

/**
 * Company defaults used by Settings and (later) lead currency / follow-up timezone.
 * Always scoped to `auth.companyId` — never trust client companyId.
 */

/**
 * @param {object} company
 * @param {object} [emailReports]
 * @returns {object}
 */
function presentCompany(company, emailReports) {
  const enabled = mergeEnabledCurrencies(company.enabledCurrencies)
  const payload = {
    id: company.id,
    name: company.name,
    timezone: company.timezone,
    baseCurrency: company.baseCurrency,
    enabledCurrencies: enabled,
    emailReportsEnabled: Boolean(company.emailReportsEnabled),
  }
  if (emailReports) {
    payload.emailReports = emailReports
  }
  return payload
}

/**
 * @param {object} auth
 * @returns {Promise<object>}
 */
async function getCompany(auth) {
  const { Company } = getModels()
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  const emailReports = await presentEmailReports(company)
  return presentCompany(company, emailReports)
}

/**
 * Updates timezone and base currency. Base currency must be in enabledCurrencies.
 *
 * @param {object} auth
 * @param {object} body
 * @returns {Promise<object>}
 */
async function updateCompany(auth, body) {
  const { Company } = getModels()
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  const timezone = readText(body, 'timezone')
  const allowedTimezones = Object.values(timezones)
  if (!allowedTimezones.includes(timezone)) {
    throw new AppError(errors.timezoneInvalid, 400)
  }
  const baseCurrency = readText(body, 'baseCurrency')
  const allowedCurrencies = Object.values(currencies)
  if (!allowedCurrencies.includes(baseCurrency)) {
    throw new AppError(errors.currencyInvalid, 400)
  }
  const enabled = mergeEnabledCurrencies(company.enabledCurrencies)
  if (!enabled.includes(baseCurrency)) {
    enabled.push(baseCurrency)
  }
  company.timezone = timezone
  company.baseCurrency = baseCurrency
  company.enabledCurrencies = enabled
  await company.save()
  const emailReports = await presentEmailReports(company)
  return presentCompany(company, emailReports)
}

module.exports = {
  getCompany,
  updateCompany,
  presentCompany,
}
