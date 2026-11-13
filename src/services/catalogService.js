const { v4: uuidv4 } = require('uuid')
const { Op } = require('sequelize')
const { getModels } = require('../models')
const { security } = require('../config/security')
const { catalogKinds, catalogTones, permissionKeys } = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { isUuid, isWithinLength, normalizeNameKey, readText } = require('../utils/helpers')

/**
 * Catalog (status / tag / activity) management — legacy faloniq catalogService parity.
 * Tenant isolation always uses `auth.companyId`. Lead-use checks stay soft until Lead tables exist.
 */

/**
 * @param {object} item
 * @returns {object}
 */
function presentCatalogItem(item) {
  return {
    id: item.id,
    companyId: item.companyId,
    kind: item.kind,
    key: item.key,
    name: item.name,
    sortOrder: item.sortOrder,
    tone: item.tone || catalogTones.none,
    isActive: Boolean(item.isActive),
    isSystem: Boolean(item.isSystem),
  }
}

/**
 * Accepts Harmoniq uppercase kinds or legacy lowercase (`status` → `STATUS`).
 *
 * @param {string} kind
 * @returns {string}
 */
function readKind(kind) {
  const raw = String(kind || '').trim()
  const upper = raw.toUpperCase()
  const allowed = Object.values(catalogKinds)
  if (allowed.includes(upper)) {
    return upper
  }
  throw new AppError(errors.catalogKindInvalid, 400)
}

/**
 * Settings may request inactive items; lead dropdowns must not.
 *
 * @param {object} auth
 * @param {object} query
 * @returns {boolean}
 */
function includeInactiveItems(auth, query) {
  if (readText(query, 'includeInactive') !== 'true') {
    return false
  }
  if (auth.role?.isProtected) {
    return true
  }
  const permissions = auth.role?.permissions || []
  return permissions.includes(permissionKeys.settingsManage)
}

/**
 * @param {object} auth
 * @param {object} query
 * @returns {Promise<object[]>}
 */
async function listCatalog(auth, query) {
  const { CatalogItem } = getModels()
  const kind = readKind(readText(query, 'kind'))
  const where = {
    companyId: auth.companyId,
    kind,
  }
  if (!includeInactiveItems(auth, query)) {
    where.isActive = true
  }
  const items = await CatalogItem.findAll({
    where,
    order: [['sortOrder', 'ASC'], ['name', 'ASC']],
  })
  return items.map(presentCatalogItem)
}

/**
 * @param {object} auth
 * @param {object} body
 * @returns {Promise<object>}
 */
async function createCatalogItem(auth, body) {
  const { CatalogItem } = getModels()
  const kind = readKind(readText(body, 'kind'))
  const name = readName(body)
  await assertNameFree(auth.companyId, kind, name, null)
  const tone = readCreateTone(kind, body)
  const key = await buildCustomKey(auth.companyId, kind, name)
  const sortOrder = await nextSortOrder(auth.companyId, kind)
  const item = await CatalogItem.create({
    id: uuidv4(),
    companyId: auth.companyId,
    kind,
    key,
    name,
    sortOrder,
    tone,
    isActive: true,
    isSystem: false,
  })
  return presentCatalogItem(item)
}

/**
 * @param {object} auth
 * @param {string} itemId
 * @param {object} body
 * @returns {Promise<object>}
 */
async function updateCatalogItem(auth, itemId, body) {
  const item = await findCompanyItem(auth, itemId)
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = readName(body)
    await assertNameFree(auth.companyId, item.kind, name, item.id)
    item.name = name
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    item.sortOrder = readSortOrder(body.sortOrder)
  }
  if (item.kind === catalogKinds.tag) {
    if (Object.prototype.hasOwnProperty.call(body, 'tone')) {
      item.tone = readTagTone(readText(body, 'tone'))
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isActive')) {
    if (body.isActive !== true && body.isActive !== false) {
      throw new AppError(errors.catalogActiveInvalid, 400)
    }
    item.isActive = body.isActive
  }
  await item.save()
  return presentCatalogItem(item)
}

/**
 * @param {object} auth
 * @param {string} itemId
 * @returns {Promise<object>}
 */
async function deleteCatalogItem(auth, itemId) {
  const { CatalogItem } = getModels()
  const item = await findCompanyItem(auth, itemId)
  if (item.isSystem) {
    throw new AppError(errors.systemCatalogLocked, 400)
  }
  const uses = await countLeadUses(item)
  if (uses > 0) {
    throw new AppError(errors.catalogInUse, 400)
  }
  const presented = presentCatalogItem(item)
  await CatalogItem.destroy({ where: { id: item.id, companyId: auth.companyId } })
  return presented
}

/**
 * @param {object} auth
 * @param {string} itemId
 * @returns {Promise<object>}
 */
async function findCompanyItem(auth, itemId) {
  const { CatalogItem } = getModels()
  if (!isUuid(itemId)) {
    throw new AppError(errors.invalidId, 400)
  }
  const item = await CatalogItem.findOne({
    where: { id: itemId, companyId: auth.companyId },
  })
  if (!item) {
    throw new AppError(errors.catalogNotFound, 400)
  }
  return item
}

function readName(body) {
  const name = readText(body, 'name')
  if (!name) {
    throw new AppError(errors.nameRequired, 400)
  }
  if (!isWithinLength(name, security.nameMaxLength)) {
    throw new AppError(errors.valueTooLong, 400)
  }
  return name
}

function readCreateTone(kind, body) {
  if (kind !== catalogKinds.tag) {
    return catalogTones.none
  }
  return readTagTone(readText(body, 'tone'))
}

function readTagTone(tone) {
  if (!tone || tone === catalogTones.none) {
    throw new AppError(errors.catalogToneRequired, 400)
  }
  const allowed = [catalogTones.green, catalogTones.red, catalogTones.amber, catalogTones.blue]
  if (!allowed.includes(tone)) {
    throw new AppError(errors.catalogToneInvalid, 400)
  }
  return tone
}

function readSortOrder(value) {
  const order = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(order) || order < 1 || order > 10000) {
    throw new AppError(errors.catalogOrderInvalid, 400)
  }
  return order
}

async function assertNameFree(companyId, kind, name, exceptId) {
  const { CatalogItem } = getModels()
  const wanted = normalizeNameKey(name)
  const items = await CatalogItem.findAll({ where: { companyId, kind } })
  for (const item of items) {
    if (exceptId && item.id === exceptId) {
      continue
    }
    if (normalizeNameKey(item.name) === wanted) {
      throw new AppError(errors.catalogNameTaken, 409)
    }
  }
}

async function buildCustomKey(companyId, kind, name) {
  const { CatalogItem } = getModels()
  const normalized = normalizeNameKey(name)
  let key = 'custom_'
  for (const character of normalized) {
    if (/[a-z0-9]/.test(character)) {
      key += character
    } else {
      key += '_'
    }
  }
  if (key === 'custom_') {
    key = 'custom_item'
  }
  let candidate = key
  let suffix = 2
  let found = await CatalogItem.findOne({ where: { companyId, kind, key: candidate } })
  while (found) {
    candidate = `${key}_${suffix}`
    suffix += 1
    found = await CatalogItem.findOne({ where: { companyId, kind, key: candidate } })
  }
  return candidate
}

async function nextSortOrder(companyId, kind) {
  const { CatalogItem } = getModels()
  const latest = await CatalogItem.findOne({
    where: { companyId, kind },
    order: [['sortOrder', 'DESC']],
  })
  if (!latest) {
    return 1
  }
  return latest.sortOrder + 1
}

/**
 * Blocks deletion when a lead references the item. Returns 0 until Lead models exist.
 *
 * @param {object} item
 * @returns {Promise<number>}
 */
async function countLeadUses(item) {
  const models = getModels()
  const Lead = models.Lead
  if (!Lead) {
    return 0
  }
  if (item.kind === catalogKinds.status) {
    return Lead.count({ where: { companyId: item.companyId, statusId: item.id } })
  }
  if (item.kind === catalogKinds.tag) {
    return models.LeadTag.count({ where: { companyId: item.companyId, tagId: item.id } })
  }
  return models.LeadActivity.count({ where: { companyId: item.companyId, activityTypeId: item.id } })
}

module.exports = {
  listCatalog,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
  presentCatalogItem,
  readKind,
}
