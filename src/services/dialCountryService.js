const { getModels } = require('../models')
const { AppError, errors } = require('../utils/errors')

/**
 * Lists active dial countries from MySQL (global reference data).
 *
 * @returns {Promise<{ countries: Array<{ id: string, name: string, code: string }> }>}
 */
async function listDialCountries() {
  const { DialCountry } = getModels()
  const rows = await DialCountry.findAll({
    where: { isActive: true },
    order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    attributes: ['id', 'name', 'code'],
  })
  return { countries: rows }
}

/**
 * Resolves a dial country by display name.
 *
 * @param {string} name
 * @returns {Promise<object>}
 */
async function findDialCountryByName(name) {
  const { DialCountry } = getModels()
  const country = await DialCountry.findOne({
    where: { name: String(name || '').trim(), isActive: true },
  })
  if (!country) {
    throw new AppError(errors.countryInvalid, 400)
  }
  return country
}

/**
 * Strips non-digits and a leading trunk zero from a local mobile number.
 *
 * @param {string} value
 * @returns {string}
 */
function nationalDigits(value) {
  let digits = String(value || '').replace(/\D/g, '')
  if (digits.startsWith('0')) {
    digits = digits.slice(1)
  }
  return digits
}

module.exports = {
  listDialCountries,
  findDialCountryByName,
  nationalDigits,
}
