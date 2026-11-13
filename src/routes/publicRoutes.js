const express = require('express')
const { asyncHandler } = require('../middleware/asyncHandler')
const { listDialCountries } = require('../services/dialCountryService')

const publicRouter = express.Router()

/**
 * GET /api/public/dial-countries — active dial catalog for registration forms.
 */
publicRouter.get('/dial-countries', asyncHandler(async (req, res) => {
  const result = await listDialCountries()
  res.status(200).json({ data: result })
}))

module.exports = { publicRouter }
