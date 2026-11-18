'use strict'

/**
 * P1: Enforce one actively connected Facebook Page owner globally.
 *
 * Adds a MySQL generated column that is pageId only when status = 'connected',
 * otherwise NULL. A unique index on that column allows many disconnected rows
 * (NULL is not unique in MySQL) while blocking two connected owners.
 *
 * SAFETY:
 * - Does not transfer, delete, or change ownership of existing rows.
 * - Aborts if duplicate connected pageIds already exist (manual resolve required).
 * - This file must be reviewed and applied manually — do not auto-run in this task.
 */

const INDEX_NAME = 'meta_pages_connected_page_uidx'
const COLUMN_NAME = 'connectedPageKey'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [duplicates] = await queryInterface.sequelize.query(`
      SELECT
        pageId,
        COUNT(*) AS connectedCount,
        GROUP_CONCAT(DISTINCT companyId ORDER BY companyId SEPARATOR ',') AS companyIds,
        GROUP_CONCAT(id ORDER BY createdAt SEPARATOR ',') AS metaPageIds
      FROM meta_pages
      WHERE status = 'connected'
      GROUP BY pageId
      HAVING COUNT(*) > 1
    `)

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const summary = duplicates.map((row) => ({
        pageId: row.pageId,
        connectedCount: Number(row.connectedCount),
        companyIds: String(row.companyIds || '').split(',').filter(Boolean),
        metaPageIds: String(row.metaPageIds || '').split(',').filter(Boolean),
      }))
      throw new Error(
        `Cannot add ${INDEX_NAME}: duplicate connected Facebook Page ownership exists. `
        + 'Resolve manually (do not silently transfer ownership), then re-run. '
        + `Duplicates: ${JSON.stringify(summary)}`,
      )
    }

    await queryInterface.sequelize.query(`
      ALTER TABLE meta_pages
      ADD COLUMN ${COLUMN_NAME} VARCHAR(64)
      GENERATED ALWAYS AS (
        CASE WHEN status = 'connected' THEN pageId ELSE NULL END
      ) STORED
    `)

    await queryInterface.addIndex('meta_pages', [COLUMN_NAME], {
      unique: true,
      name: INDEX_NAME,
    })
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('meta_pages', INDEX_NAME)
    await queryInterface.removeColumn('meta_pages', COLUMN_NAME)
  },
}
