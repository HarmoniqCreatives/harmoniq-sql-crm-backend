const {
  createRole,
  deleteRole,
  getRole,
  listRoles,
  updateRole,
} = require('../../services/roleService')
const { presentPermissionMatrix } = require('../../services/accessService')

/** GET /api/roles */
async function getRoles(req, res) {
  const result = await listRoles(req.auth)
  res.status(200).json({ data: result })
}

/** GET /api/roles/permissions — registry matrix only. */
async function getPermissions(req, res) {
  res.status(200).json({
    data: {
      permissionMatrix: presentPermissionMatrix(),
    },
  })
}

/** GET /api/roles/:id */
async function getRoleById(req, res) {
  const result = await getRole(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

/** POST /api/roles — custom role create. */
async function postRole(req, res) {
  const result = await createRole(req.auth, req.body)
  res.status(201).json({ data: result })
}

/** PATCH /api/roles/:id */
async function patchRole(req, res) {
  const result = await updateRole(req.auth, req.params.id, req.body)
  res.status(200).json({ data: result })
}

/** DELETE /api/roles/:id — custom roles only. */
async function removeRole(req, res) {
  const result = await deleteRole(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

module.exports = {
  getRoles,
  getPermissions,
  getRoleById,
  postRole,
  patchRole,
  removeRole,
}
