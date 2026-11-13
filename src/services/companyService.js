const { getModels } = require('../models')
const { timezones } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { readText } = require('../utils/helpers')

/**
 * Company defaults used by Settings and (later) lead currency / follow-up timezone.
 * Always scoped to `auth.companyId` — never trust client companyId.
 */

/**
 * @param {object} company
 * @returns {object}
 */
function presentCompany(company) {
  const enabled = Array.isArray(company.enabledCurrencies)
    ? company.enabledCurrencies
    : []
  return {
    id: company.id,
    name: company.name,
    timezone: company.timezone,
    baseCurrency: company.baseCurrency,
    enabledCurrencies: enabled,
  }
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
  return presentCompany(company)
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
  const enabled = Array.isArray(company.enabledCurrencies) ? company.enabledCurrencies : []
  if (!enabled.includes(baseCurrency)) {
    throw new AppError(errors.currencyInvalid, 400)
  }
  company.timezone = timezone
  company.baseCurrency = baseCurrency
  await company.save()
  return presentCompany(company)
}

module.exports = {
  getCompany,
  updateCompany,
  presentCompany,
}
