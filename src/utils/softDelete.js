'use strict'

/**
 * Shared soft-delete helpers for entities that use `isDeleted` (+ deletedAt/deletedBy).
 * Leads keep Sequelize paranoid `deletedAt` — do not use markSoftDeleted on Lead.
 */

/**
 * Active-row filter for isDeleted-based models.
 * @param {object} [where]
 */
function activeWhere(where = {}) {
  return { ...where, isDeleted: false }
}

/**
 * Soft-delete a Sequelize instance (isDeleted models only).
 * Does not use DB CASCADE.
 *
 * @param {import('sequelize').Model} row
 * @param {{ userId?: string|null, transaction?: object }} [options]
 */
async function markSoftDeleted(row, options = {}) {
  row.set('isDeleted', true)
  row.set('deletedAt', new Date())
  row.set('deletedBy', options.userId || null)
  await row.save({ transaction: options.transaction })
  return row
}

/**
 * Restore a soft-deleted isDeleted row.
 * @param {import('sequelize').Model} row
 * @param {{ transaction?: object }} [options]
 */
async function markRestored(row, options = {}) {
  row.set('isDeleted', false)
  row.set('deletedAt', null)
  row.set('deletedBy', null)
  await row.save({ transaction: options.transaction })
  return row
}

/**
 * Derived API flag for any row (paranoid leads or isDeleted models).
 * @param {object|null|undefined} row
 * @returns {boolean}
 */
function deriveIsDeleted(row) {
  if (!row) return false
  if (row.isDeleted === true || row.isDeleted === 1) return true
  if (row.deletedAt) return true
  return false
}

module.exports = {
  activeWhere,
  markSoftDeleted,
  markRestored,
  deriveIsDeleted,
}
