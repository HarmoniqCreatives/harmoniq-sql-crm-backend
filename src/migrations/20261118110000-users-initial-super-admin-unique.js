'use strict'

/**
 * P2: Enforce at most one isInitialSuperAdmin=true user per company.
 *
 * VIRTUAL generated column holds companyId only when isInitialSuperAdmin is true;
 * otherwise NULL. Unique secondary index allows many non-initial users (NULL is
 * not unique in MySQL) while blocking a second initial Super Admin in the same
 * company.
 *
 * VIRTUAL (not STORED) is required on MySQL 8.4 / InnoDB because users.companyId
 * has ON UPDATE/DELETE CASCADE to companies.id, and CASCADE is forbidden on a
 * base column of a STORED generated column.
 *
 * SAFETY:
 * - Does not demote, delete, or transfer users.
 * - Aborts if duplicate initial Super Admins already exist (manual resolve).
 * - Create the file only in this task — do not auto-run against local/live DBs.
 */

const INDEX_NAME = 'users_initial_super_admin_company_uidx'
const COLUMN_NAME = 'initialSuperAdminCompanyKey'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [duplicates] = await queryInterface.sequelize.query(`
      SELECT
        companyId,
        COUNT(*) AS initialCount,
        GROUP_CONCAT(id ORDER BY createdAt SEPARATOR ',') AS userIds,
        GROUP_CONCAT(email ORDER BY createdAt SEPARATOR ',') AS emails
      FROM users
      WHERE isInitialSuperAdmin = 1
      GROUP BY companyId
      HAVING COUNT(*) > 1
    `)

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const summary = duplicates.map((row) => ({
        companyId: row.companyId,
        initialCount: Number(row.initialCount),
        userIds: String(row.userIds || '').split(',').filter(Boolean),
        emails: String(row.emails || '').split(',').filter(Boolean),
      }))
      throw new Error(
        `Cannot add ${INDEX_NAME}: multiple isInitialSuperAdmin=true users exist for the same company. `
        + 'Resolve manually (never auto-demote), then re-run. '
        + `Duplicates: ${JSON.stringify(summary)}`,
      )
    }

    await queryInterface.sequelize.query(`
      ALTER TABLE users
      ADD COLUMN ${COLUMN_NAME} CHAR(36)
      GENERATED ALWAYS AS (
        CASE WHEN isInitialSuperAdmin = 1 THEN companyId ELSE NULL END
      ) VIRTUAL
    `)

    await queryInterface.addIndex('users', [COLUMN_NAME], {
      unique: true,
      name: INDEX_NAME,
    })
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('users', INDEX_NAME)
    await queryInterface.removeColumn('users', COLUMN_NAME)
  },
}
