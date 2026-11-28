'use strict'

/**
 * Permanent lead origin tracking — add `importedAt` and safe provenance backfill.
 *
 * Reuses existing `entryMethod` + `importSessionId` (no duplicate addedVia/importBatchId columns).
 * Adds allowed value `unknown` via data backfill (column remains VARCHAR).
 *
 * Cutoff (PROVENANCE_FEATURE_DAY):
 * - Excel provenance migration id is `20261125120000-lead-excel-import.js`.
 * - SequelizeMeta stores only migration names (no applied_at).
 * - Earliest local import session on audit was 2026-11-25; migration calendar day is 2026-11-25.
 * - Therefore: leads with createdAt < 2026-11-25 00:00:00 UTC that still show entryMethod=manual
 *   with no Meta/Excel signal are treated as migration-defaulted → `unknown`.
 * - Leads with createdAt >= that day and manual + no signal stay `manual` (post-provenance creates).
 * - Never guess: Meta only via metaLeadId / existing meta_import; Excel via importSessionId / excel_import.
 *
 * IRREVERSIBLE DATA CHANGE:
 * - The `entryMethod` UPDATEs below rewrite historical provenance labels.
 * - `down` removes `importedAt` / index only — it does NOT restore prior `entryMethod` values.
 * - Take a backup and run dry-run counts on a clone before production apply.
 *
 * DRY-RUN (clone / test DB only — never production without approval):
 *   PROVENANCE_DRY_RUN=1 npx sequelize-cli db:migrate --to 20261126120000-lead-origin-imported-at.js
 *   When PROVENANCE_DRY_RUN=1, this migration logs projected UPDATE counts and makes
 *   schema changes (importedAt + index) but skips the irreversible entryMethod UPDATEs.
 *
 * SAFETY: do not run against production until explicitly approved.
 *
 * @type {import('sequelize-cli').Migration}
 */

const PROVENANCE_FEATURE_DAY = '2026-11-25 00:00:00'

function isAlreadyExistsError(error) {
  const message = String((error && error.message) || error || '')
  return /already exists|Duplicate key name|ER_DUP_KEYNAME/i.test(message)
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const dryRun = String(process.env.PROVENANCE_DRY_RUN || '') === '1'
    const table = await queryInterface.describeTable('leads')
    if (!table.importedAt) {
      await queryInterface.addColumn('leads', 'importedAt', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      })
    }

    const dialect = queryInterface.sequelize.getDialect()
    if (dialect !== 'mysql' && dialect !== 'mariadb') {
      throw new Error('lead-origin backfill supports MySQL/MariaDB only')
    }

    if (dryRun) {
      const [metaCount] = await queryInterface.sequelize.query(`
        SELECT COUNT(*) AS c FROM leads
        WHERE (metaLeadId IS NOT NULL AND metaLeadId <> '')
          AND entryMethod <> 'excel_import'
          AND (importSessionId IS NULL)
          AND entryMethod <> 'meta_import'
      `)
      const [excelCount] = await queryInterface.sequelize.query(`
        SELECT COUNT(*) AS c FROM leads
        WHERE importSessionId IS NOT NULL
          AND entryMethod <> 'excel_import'
      `)
      const [unknownCount] = await queryInterface.sequelize.query(`
        SELECT COUNT(*) AS c FROM leads
        WHERE entryMethod = 'manual'
          AND (metaLeadId IS NULL OR metaLeadId = '')
          AND importSessionId IS NULL
          AND createdAt < :cutoff
      `, { replacements: { cutoff: PROVENANCE_FEATURE_DAY } })
      console.log(JSON.stringify({
        event: 'provenance_dry_run',
        note: 'entryMethod UPDATEs skipped; importedAt column may have been added',
        wouldSetMetaImport: Number(metaCount[0].c),
        wouldSetExcelImport: Number(excelCount[0].c),
        wouldSetUnknown: Number(unknownCount[0].c),
        cutoff: PROVENANCE_FEATURE_DAY,
      }))
    } else {
      // 1) Reliable Meta → meta_import (do not touch excel rows)
      await queryInterface.sequelize.query(`
        UPDATE leads
        SET entryMethod = 'meta_import'
        WHERE (metaLeadId IS NOT NULL AND metaLeadId <> '')
          AND entryMethod <> 'excel_import'
          AND (importSessionId IS NULL)
          AND entryMethod <> 'meta_import'
      `)

      // 2) Reliable Excel → excel_import
      await queryInterface.sequelize.query(`
        UPDATE leads
        SET entryMethod = 'excel_import'
        WHERE importSessionId IS NOT NULL
          AND entryMethod <> 'excel_import'
      `)

      // 3) Pre-provenance manual defaults with no reliable signal → unknown
      await queryInterface.sequelize.query(`
        UPDATE leads
        SET entryMethod = 'unknown'
        WHERE entryMethod = 'manual'
          AND (metaLeadId IS NULL OR metaLeadId = '')
          AND importSessionId IS NULL
          AND createdAt < :cutoff
      `, { replacements: { cutoff: PROVENANCE_FEATURE_DAY } })

      // 4) importedAt for Meta (CRM insert time)
      await queryInterface.sequelize.query(`
        UPDATE leads
        SET importedAt = createdAt
        WHERE entryMethod = 'meta_import'
          AND importedAt IS NULL
      `)

      // 5) importedAt for Excel — prefer session completedAt, else lead createdAt
      await queryInterface.sequelize.query(`
        UPDATE leads l
        LEFT JOIN lead_import_sessions s
          ON s.id = l.importSessionId
         AND s.companyId = l.companyId
        SET l.importedAt = COALESCE(s.completedAt, l.createdAt)
        WHERE l.entryMethod = 'excel_import'
          AND l.importedAt IS NULL
      `)
    }

    // Manual / unknown / api_import keep importedAt NULL

    try {
      await queryInterface.addIndex('leads', ['companyId', 'importedAt'], {
        name: 'leads_company_imported_at_idx',
      })
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeIndex('leads', 'leads_company_imported_at_idx')
    } catch (error) {
      if (!isAlreadyExistsError(error)
        && !/does not exist|Can't DROP|ER_CANT_DROP_FIELD|Unknown key/i.test(String(error.message || ''))) {
        throw error
      }
    }
    const table = await queryInterface.describeTable('leads')
    if (table.importedAt) {
      await queryInterface.removeColumn('leads', 'importedAt')
    }
    // Do not reverse entryMethod backfill — irreversible without a pre-migration backup.
  },
}
