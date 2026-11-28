'use strict'

/**
 * Soft-delete columns for approved entities (not Leads — Leads keep paranoid deletedAt).
 *
 * Adds: isDeleted TINYINT(1) NOT NULL DEFAULT 0, deletedAt DATETIME NULL, deletedBy CHAR(36) NULL
 * Indexes: (companyId, isDeleted) where company-scoped.
 *
 * Index errors: "already exists" is ignored; any other failure aborts the migration.
 *
 * SAFETY: do not run against production until explicitly approved.
 *
 * @type {import('sequelize-cli').Migration}
 */

const TABLES = [
  'roles',
  'catalog_items',
  'meta_app_profiles',
  'meta_connections',
  'meta_pages',
  'company_email_reports',
]

function isAlreadyExistsError(error) {
  const message = String((error && error.message) || error || '')
  return /already exists|Duplicate key name|ER_DUP_KEYNAME/i.test(message)
}

function isMissingIndexError(error) {
  const message = String((error && error.message) || error || '')
  return /does not exist|Can't DROP|ER_CANT_DROP_FIELD|Unknown key|check that it exists/i.test(message)
}

async function addSoftDeleteColumns(queryInterface, Sequelize, tableName) {
  const table = await queryInterface.describeTable(tableName)
  if (!table.isDeleted) {
    await queryInterface.addColumn(tableName, 'isDeleted', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    })
  }
  if (!table.deletedAt) {
    await queryInterface.addColumn(tableName, 'deletedAt', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    })
  }
  if (!table.deletedBy) {
    await queryInterface.addColumn(tableName, 'deletedBy', {
      type: Sequelize.CHAR(36),
      allowNull: true,
      defaultValue: null,
    })
  }
  const indexName = `${tableName}_company_is_deleted_idx`
  try {
    await queryInterface.addIndex(tableName, ['companyId', 'isDeleted'], { name: indexName })
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error
    }
  }
}

async function removeSoftDeleteColumns(queryInterface, tableName) {
  const indexName = `${tableName}_company_is_deleted_idx`
  try {
    await queryInterface.removeIndex(tableName, indexName)
  } catch (error) {
    if (!isMissingIndexError(error)) {
      throw error
    }
  }
  const table = await queryInterface.describeTable(tableName)
  if (table.deletedBy) await queryInterface.removeColumn(tableName, 'deletedBy')
  if (table.deletedAt) await queryInterface.removeColumn(tableName, 'deletedAt')
  if (table.isDeleted) await queryInterface.removeColumn(tableName, 'isDeleted')
}

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const tableName of TABLES) {
      await addSoftDeleteColumns(queryInterface, Sequelize, tableName)
    }
  },

  async down(queryInterface) {
    for (const tableName of [...TABLES].reverse()) {
      await removeSoftDeleteColumns(queryInterface, tableName)
    }
  },
}
