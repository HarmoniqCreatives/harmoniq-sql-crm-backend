'use strict'

const { Op } = require('sequelize')
const { metaPageStatuses } = require('../utils/enums')
const { errors } = require('../utils/errors')

/**
 * Global Facebook Page ownership while status = connected.
 * One pageId may be actively connected to only one company.
 * Disconnected / inaccessible / expired rows do not reserve ownership.
 */

const CONNECTED_PAGE_UNIQUE_INDEX = 'meta_pages_connected_page_uidx'

/**
 * Finds a connected MetaPage owned by a different company for the same Facebook pageId.
 * @returns {Promise<object|null>}
 */
async function findForeignConnectedOwner(MetaPage, pageId, companyId, options = {}) {
  const where = {
    pageId: String(pageId),
    status: metaPageStatuses.connected,
    companyId: { [Op.ne]: companyId },
  }
  const query = {
    where,
    order: [['createdAt', 'ASC']],
  }
  if (options.transaction) {
    query.transaction = options.transaction
    query.lock = options.transaction.LOCK.UPDATE
  }
  return MetaPage.findOne(query)
}

/**
 * Resolves the canonical connected owner for webhook routing.
 * If duplicates exist (pre-migration), uses the oldest row and logs without modifying data.
 * @returns {Promise<object|null>}
 */
async function findCanonicalConnectedPage(MetaPage, pageId) {
  const pages = await MetaPage.findAll({
    where: {
      pageId: String(pageId),
      status: metaPageStatuses.connected,
    },
    order: [['createdAt', 'ASC']],
  })
  if (pages.length > 1) {
    console.error(JSON.stringify({
      event: 'meta_page_duplicate_connected_owners',
      pageId: String(pageId),
      count: pages.length,
      companyIds: pages.map((row) => row.companyId),
      metaPageIds: pages.map((row) => row.id),
      canonicalCompanyId: pages[0].companyId,
      canonicalMetaPageId: pages[0].id,
    }))
  }
  return pages[0] || null
}

/**
 * Read-only detection of pageIds with more than one connected row.
 * Does not modify any records.
 * @returns {Promise<Array<{ pageId: string, count: number, companyIds: string[], metaPageIds: string[] }>>}
 */
async function detectDuplicateConnectedPageOwners(MetaPage) {
  const rows = await MetaPage.findAll({
    where: { status: metaPageStatuses.connected },
    attributes: ['id', 'pageId', 'companyId', 'createdAt'],
    order: [['pageId', 'ASC'], ['createdAt', 'ASC']],
  })
  const byPage = new Map()
  for (const row of rows) {
    const key = String(row.pageId)
    if (!byPage.has(key)) byPage.set(key, [])
    byPage.get(key).push(row)
  }
  const duplicates = []
  for (const [pageId, group] of byPage) {
    if (group.length < 2) continue
    duplicates.push({
      pageId,
      count: group.length,
      companyIds: group.map((row) => row.companyId),
      metaPageIds: group.map((row) => row.id),
    })
  }
  return duplicates
}

/**
 * True when a unique-constraint failure is the global connected-page owner index.
 */
function isConnectedPageOwnershipConflict(error) {
  if (!error || error.name !== 'SequelizeUniqueConstraintError') return false
  const indexName = String(error?.parent?.sqlMessage || error?.message || '')
  if (indexName.includes(CONNECTED_PAGE_UNIQUE_INDEX) || indexName.includes('connectedPageKey')) {
    return true
  }
  const fields = error.fields || {}
  if (Object.prototype.hasOwnProperty.call(fields, 'connectedPageKey')) {
    return true
  }
  return false
}

function ownershipConflictReason() {
  return errors.metaPageOwnedByAnotherCompany
}

module.exports = {
  CONNECTED_PAGE_UNIQUE_INDEX,
  detectDuplicateConnectedPageOwners,
  findCanonicalConnectedPage,
  findForeignConnectedOwner,
  isConnectedPageOwnershipConflict,
  ownershipConflictReason,
}
