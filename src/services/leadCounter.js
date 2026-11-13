const { QueryTypes } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { getModels } = require('../models')

const leadCounterKey = 'lead'
/**
 * Mirrors legacy `firstLeadNumber` in faloniq `leadService.js`.
 * Counter row is seeded at 1000, then always incremented before use,
 * so the first allocated lead number is **1001**.
 */
const firstLeadNumber = 1000

/**
 * Allocates the next lead number for a company inside an open transaction.
 *
 * Legacy algorithm (`nextLeadNumber`):
 * 1. If no counter row exists, create it with `value = 1000`.
 * 2. Atomically `$inc` by 1 and return the new value.
 *
 * SQL equivalent (concurrency-safe):
 * 1. `INSERT … ON DUPLICATE KEY UPDATE id = id` seeds `value = 1000` once.
 * 2. `UPDATE … SET value = LAST_INSERT_ID(value + 1)` then `SELECT LAST_INSERT_ID()`.
 *
 * @param {string} companyId
 * @param {import('sequelize').Transaction} transaction
 * @returns {Promise<number>}
 */
async function allocateLeadNumber(companyId, transaction) {
  const { sequelize } = getModels()
  await sequelize.query(
    `INSERT INTO counters (id, companyId, \`key\`, value, createdAt, updatedAt)
     VALUES (:id, :companyId, :key, :seed, NOW(), NOW())
     ON DUPLICATE KEY UPDATE id = id`,
    {
      replacements: {
        id: uuidv4(),
        companyId,
        key: leadCounterKey,
        seed: firstLeadNumber,
      },
      transaction,
    },
  )
  await sequelize.query(
    `UPDATE counters
     SET value = LAST_INSERT_ID(value + 1), updatedAt = NOW()
     WHERE companyId = :companyId AND \`key\` = :key`,
    {
      replacements: {
        companyId,
        key: leadCounterKey,
      },
      transaction,
    },
  )
  const rows = await sequelize.query(
    'SELECT LAST_INSERT_ID() AS nextNumber',
    { transaction, type: QueryTypes.SELECT },
  )
  const nextNumber = Number(rows[0]?.nextNumber)
  if (!Number.isInteger(nextNumber) || nextNumber < firstLeadNumber + 1) {
    throw new Error('Lead counter allocation failed')
  }
  return nextNumber
}

module.exports = {
  allocateLeadNumber,
  leadCounterKey,
  firstLeadNumber,
}
