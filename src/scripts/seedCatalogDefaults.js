#!/usr/bin/env node
/**
 * Idempotent catalog seed for every company.
 * Inserts missing system defaults (e.g. Angry tag) by (companyId, kind, key).
 * Never renames or overwrites custom/user-edited rows; updates tone/name/sortOrder
 * only for existing system items that still match the seed key.
 */
const { v4: uuidv4 } = require('uuid')
const { catalogSeeds } = require('../config/seed')
const { getModels } = require('../models')

/**
 * @param {string} companyId
 * @param {import('sequelize').ModelStatic} CatalogItem
 * @param {import('sequelize').Transaction} transaction
 */
async function seedCompanyCatalog(companyId, CatalogItem, transaction) {
  let inserted = 0
  let updated = 0
  for (const seed of catalogSeeds) {
    const existing = await CatalogItem.findOne({
      where: { companyId, kind: seed.kind, key: seed.key },
      transaction,
    })
    if (existing) {
      if (existing.isSystem) {
        // Align system defaults without touching isActive (operators may deactivate).
        existing.name = seed.name
        existing.sortOrder = seed.sortOrder
        existing.tone = seed.tone
        await existing.save({ transaction })
        updated += 1
      }
      continue
    }
    await CatalogItem.create({
      id: uuidv4(),
      companyId,
      kind: seed.kind,
      key: seed.key,
      name: seed.name,
      sortOrder: seed.sortOrder,
      tone: seed.tone,
      isActive: true,
      isSystem: true,
    }, { transaction })
    inserted += 1
  }
  return { inserted, updated }
}

async function main() {
  const { sequelize, Company, CatalogItem } = getModels()
  await sequelize.authenticate()
  const companies = await Company.findAll({ attributes: ['id', 'name'] })
  let insertedTotal = 0
  let updatedTotal = 0
  await sequelize.transaction(async (transaction) => {
    for (const company of companies) {
      const result = await seedCompanyCatalog(company.id, CatalogItem, transaction)
      insertedTotal += result.inserted
      updatedTotal += result.updated
    }
  })
  console.log(JSON.stringify({
    event: 'catalog_defaults_seeded',
    companies: companies.length,
    inserted: insertedTotal,
    updated: updatedTotal,
    seedKeys: catalogSeeds.map((row) => `${row.kind}:${row.key}`),
  }))
  await sequelize.close()
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(JSON.stringify({
      event: 'catalog_defaults_seed_failed',
      message: error.message,
    }))
    process.exitCode = 1
  })
}

module.exports = { seedCompanyCatalog, main }
