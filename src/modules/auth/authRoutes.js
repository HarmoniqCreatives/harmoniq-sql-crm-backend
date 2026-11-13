const express = require('express')
const { requireAuth } = require('../../middleware/auth')
const { asyncHandler } = require('../../middleware/asyncHandler')
const {
  loginLimiter,
  passwordLimiter,
  registerLimiter,
  verifyLimiter,
} = require('../../middleware/rateLimit')
const {
  getCompanies,
  getMe,
  postForgotPassword,
  postLogin,
  postLogout,
  postLogoutAll,
  postRefresh,
  postRegister,
  postResendVerification,
  postResetPassword,
  postVerifyEmail,
} = require('./authController')

/**
 * Auth HTTP routes (register, verify, login, session, password reset).
 * See `docs/modules/auth.md` for request/response contracts.
 */
const authRouter = express.Router()

authRouter.post('/register', registerLimiter, asyncHandler(postRegister))
authRouter.post('/verify-email', verifyLimiter, asyncHandler(postVerifyEmail))
authRouter.post('/resend-verification', verifyLimiter, asyncHandler(postResendVerification))
authRouter.get('/companies', loginLimiter, asyncHandler(getCompanies))
authRouter.post('/login', loginLimiter, asyncHandler(postLogin))
authRouter.post('/refresh', loginLimiter, asyncHandler(postRefresh))
authRouter.post('/logout', asyncHandler(postLogout))
authRouter.post('/logout-all', requireAuth, asyncHandler(postLogoutAll))
authRouter.get('/me', requireAuth, asyncHandler(getMe))
authRouter.post('/forgot-password', passwordLimiter, asyncHandler(postForgotPassword))
authRouter.post('/reset-password', passwordLimiter, asyncHandler(postResetPassword))

module.exports = { authRouter }
