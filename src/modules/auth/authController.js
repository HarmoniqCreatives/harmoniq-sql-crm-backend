const {
  forgotPassword,
  listCompaniesForEmail,
  login,
  logout,
  logoutAll,
  me,
  refresh,
  registerCompany,
  resendVerification,
  resetPassword,
  verifyEmail,
} = require('../../services/authService')
const { readText } = require('../../utils/helpers')

function requestMeta(req) {
  return {
    userAgent: req.get('user-agent') || '',
    ipAddress: req.ip || '',
  }
}

function setRefreshCookie(res, refreshToken, expiresAt) {
  res.cookie('hc_refresh', refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expiresAt),
    path: '/api/auth',
  })
}

function clearRefreshCookie(res) {
  res.clearCookie('hc_refresh', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
  })
}

async function postRegister(req, res) {
  const result = await registerCompany(req.body)
  res.status(201).json({ data: result })
}

async function postVerifyEmail(req, res) {
  const token = readText(req.body, 'token') || readText(req.query, 'token')
  const result = await verifyEmail(token)
  res.status(200).json({ data: result })
}

async function postResendVerification(req, res) {
  const result = await resendVerification(req.body)
  res.status(200).json({ data: result })
}

async function getCompanies(req, res) {
  const result = await listCompaniesForEmail(readText(req.query, 'email'))
  res.status(200).json({ data: result })
}

async function postLogin(req, res) {
  const result = await login(req.body, requestMeta(req))
  setRefreshCookie(res, result.refreshToken, result.expiresAt)
  res.status(200).json({
    data: {
      message: result.message,
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    },
  })
}

async function postRefresh(req, res) {
  const body = {
    refreshToken: readText(req.body, 'refreshToken') || req.cookies.hc_refresh || '',
  }
  const result = await refresh(body, requestMeta(req))
  setRefreshCookie(res, result.refreshToken, result.expiresAt)
  res.status(200).json({ data: result })
}

async function postLogout(req, res) {
  const body = {
    refreshToken: readText(req.body, 'refreshToken') || req.cookies.hc_refresh || '',
  }
  const result = await logout(body)
  clearRefreshCookie(res)
  res.status(200).json({ data: result })
}

async function postLogoutAll(req, res) {
  const result = await logoutAll(req.auth.userId)
  clearRefreshCookie(res)
  res.status(200).json({ data: result })
}

async function getMe(req, res) {
  const result = await me(req.auth)
  res.status(200).json({ data: result })
}

async function postForgotPassword(req, res) {
  const result = await forgotPassword(req.body)
  res.status(200).json({ data: result })
}

async function postResetPassword(req, res) {
  const result = await resetPassword(req.body)
  clearRefreshCookie(res)
  res.status(200).json({ data: result })
}

module.exports = {
  postRegister,
  postVerifyEmail,
  postResendVerification,
  getCompanies,
  postLogin,
  postRefresh,
  postLogout,
  postLogoutAll,
  getMe,
  postForgotPassword,
  postResetPassword,
}
