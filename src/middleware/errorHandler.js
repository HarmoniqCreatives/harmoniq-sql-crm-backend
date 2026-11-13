const { AppError } = require('../utils/errors')

function notFoundHandler(req, res) {
  res.status(404).json({
    data: null,
    error: {
      message: 'Route not found.',
      path: req.path,
    },
  })
}

function errorHandler(error, req, res, next) {
  let statusCode = 500
  let message = 'Unexpected server error.'
  let code
  let details
  if (error instanceof AppError) {
    statusCode = error.statusCode || 400
    message = error.message
    code = error.code
    details = error.details
  } else if (error && error.message) {
    if (process.env.NODE_ENV !== 'production') {
      message = error.message
    }
  }
  if (statusCode >= 500) {
    console.error(JSON.stringify({
      event: 'api_error',
      message: error.message || message,
      path: req.path,
    }))
  }
  const errorBody = { message }
  if (code && code !== 'APP_ERROR') {
    errorBody.code = code
  }
  if (details && typeof details === 'object') {
    Object.assign(errorBody, details)
  }
  res.status(statusCode).json({
    data: null,
    error: errorBody,
  })
}

module.exports = { notFoundHandler, errorHandler }
