'use strict'

/**
 * Minimal in-memory Sequelize-like models for isolated import tests.
 * Never connects to MySQL / harmoniq_creative_crm.
 */

function createMemoryTable(name) {
  /** @type {Map<string, object>} */
  const rows = new Map()

  return {
    name,
    sequelize: null,
    async findOrCreate({ where, defaults }) {
      const id = where.id
      if (rows.has(id)) {
        return [rows.get(id), false]
      }
      const row = {
        ...defaults,
        async save() {
          rows.set(this.id, this)
          return this
        },
      }
      rows.set(id, row)
      return [row, true]
    },
    async findByPk(id) {
      return rows.get(id) || null
    },
    async findAll() {
      return [...rows.values()]
    },
    _rows: rows,
  }
}

function createIsolatedImportModels() {
  const Company = createMemoryTable('companies')
  const Role = createMemoryTable('roles')
  const Branch = createMemoryTable('branches')
  const Team = createMemoryTable('teams')
  const User = createMemoryTable('users')

  const sequelize = {
    async transaction() {
      return {
        async commit() {},
        async rollback() {},
      }
    },
  }

  Company.sequelize = sequelize
  Role.sequelize = sequelize
  Branch.sequelize = sequelize
  Team.sequelize = sequelize
  User.sequelize = sequelize

  return { Company, Role, Branch, Team, User, sequelize }
}

module.exports = { createIsolatedImportModels, createMemoryTable }
