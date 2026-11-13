const {
  createAdminPasswordReset,
  createUser,
  getUser,
  listBranches,
  listTeams,
  listUsers,
  setUserActive,
  updateUser,
} = require('../../services/userService')
const { resolvePublicFrontendBase } = require('../../services/mailService')

/** GET /api/users — paginated directory. */
async function getUsers(req, res) {
  const result = await listUsers(req.auth, req.query)
  res.status(200).json({ data: result })
}

/** GET /api/users/:id — user detail including lastLoginAt. */
async function getUserById(req, res) {
  const result = await getUser(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

/** POST /api/users — direct create (requires password). */
async function postUser(req, res) {
  const result = await createUser(req.auth, req.body)
  res.status(201).json({ data: result })
}

/** PATCH /api/users/:id — edit profile/role/branch/team/status. */
async function patchUser(req, res) {
  const result = await updateUser(req.auth, req.params.id, req.body)
  res.status(200).json({ data: result })
}

/** POST /api/users/:id/activate */
async function postActivateUser(req, res) {
  const result = await setUserActive(req.auth, req.params.id, true)
  res.status(200).json({ data: result })
}

/** POST /api/users/:id/deactivate — revokes sessions when disabling. */
async function postDeactivateUser(req, res) {
  const result = await setUserActive(req.auth, req.params.id, false)
  res.status(200).json({ data: result })
}

/** GET /api/users/branches — assignment helper list. */
async function getBranches(req, res) {
  const result = await listBranches(req.auth)
  res.status(200).json({ data: result })
}

/** GET /api/users/teams?branchId= — assignment helper list. */
async function getTeams(req, res) {
  const result = await listTeams(req.auth, req.query)
  res.status(200).json({ data: result })
}

/**
 * POST /api/users/:id/password-reset — admin starts a reset; returns copyable reset URL once.
 */
async function postPasswordReset(req, res) {
  const publicFrontendBase = resolvePublicFrontendBase(req)
  const result = await createAdminPasswordReset(req.auth, req.params.id, publicFrontendBase)
  res.status(200).json({ data: result })
}

module.exports = {
  getUsers,
  getUserById,
  postUser,
  patchUser,
  postActivateUser,
  postDeactivateUser,
  postPasswordReset,
  getBranches,
  getTeams,
}
