#!/usr/bin/env node
/**
 * Idempotent seed for default system roles and permissions.
 * Safe to re-run: updates system role permissions/names; never deletes custom roles.
 */
const { v4: uuidv4 } = require('uuid')
const { roleSeeds } = require('../config/seed')
const { getModels } = require('../models')
const { listPermissions } = require('../config/permissions')

async function seedCompanyRoles(companyId, Role, transaction) {
  for (const seed of roleSeeds) {
    const existing = await Role.findOne({
      where: { companyId, key: seed.key },
      transaction,
    })
    if (existing) {
      existing.name = seed.name
      existing.description = seed.description
      existing.permissions = seed.permissions
      existing.scope = seed.scope
      existing.isSystem = true
      existing.isProtected = Boolean(seed.isProtected)
      await existing.save({ transaction })
      continue
    }
    await Role.create({
      id: uuidv4(),
      companyId,
      key: seed.key,
      name: seed.name,
      description: seed.description,
      permissions: seed.permissions,
      scope: seed.scope,
      isSystem: true,
      isProtected: Boolean(seed.isProtected),
    }, { transaction })
  }
}

async function main() {
  const { sequelize, Company, Role } = getModels()
  await sequelize.authenticate()
  const companies = await Company.findAll({ attributes: ['id', 'name'] })
  await sequelize.transaction(async (transaction) => {
    for (const company of companies) {
      await seedCompanyRoles(company.id, Role, transaction)
    }
  })
  console.log(JSON.stringify({
    event: 'roles_permissions_seeded',
    companies: companies.length,
    permissions: listPermissions().length,
    systemRoles: roleSeeds.map((row) => row.key),
  }))
  await sequelize.close()
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(JSON.stringify({
      event: 'roles_permissions_seed_failed',
      message: error.message,
    }))
    process.exitCode = 1
  })
}

module.exports = { seedCompanyRoles, main }
