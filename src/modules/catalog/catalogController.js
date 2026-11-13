const {
  createCatalogItem,
  deleteCatalogItem,
  listCatalog,
  updateCatalogItem,
} = require('../../services/catalogService')
const { messages } = require('../../utils/messages')

/** GET /api/catalog?kind=&includeInactive= */
async function getCatalog(req, res) {
  const items = await listCatalog(req.auth, req.query)
  res.status(200).json({ data: { items } })
}

/** POST /api/catalog */
async function postCatalogItem(req, res) {
  const item = await createCatalogItem(req.auth, req.body)
  res.status(201).json({
    data: {
      message: messages.catalogCreated,
      item,
    },
  })
}

/** PATCH /api/catalog/:id */
async function patchCatalogItem(req, res) {
  const item = await updateCatalogItem(req.auth, req.params.id, req.body)
  res.status(200).json({
    data: {
      message: messages.catalogUpdated,
      item,
    },
  })
}

/** DELETE /api/catalog/:id */
async function removeCatalogItem(req, res) {
  const item = await deleteCatalogItem(req.auth, req.params.id)
  res.status(200).json({
    data: {
      message: messages.catalogDeleted,
      item,
    },
  })
}

module.exports = {
  getCatalog,
  postCatalogItem,
  patchCatalogItem,
  removeCatalogItem,
}
