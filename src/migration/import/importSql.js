'use strict'

const { createIdMap } = require('../lib/idMap')
const { validateExportPayload, transformExportToSqlRecords } = require('../lib/validators')
const { assertPasswordGate } = require('../lib/passwordGate')
const { redactSecrets } = require('../lib/sanitize')

/**
 * Prepare SQL-ready payload without writing to the database.
 */
function prepareImportPlan(exportPayload, options = {}) {
  const validation = validateExportPayload(exportPayload)
  const idMap = createIdMap(options.idMapEntries || [])

  if (!validation.ok && options.allowInvalid !== true) {
    return {
      ok: false,
      validation,
      records: null,
      idMap: idMap.toJSON(),
    }
  }

  // Hash copy policy: plan may be built for inspection, but live import refuses without gate.
  const records = transformExportToSqlRecords(exportPayload, idMap, {
    companyForceStatuses: options.companyForceStatuses || {},
  })

  return {
    ok: validation.ok,
    validation,
    records,
    idMap: idMap.toJSON(),
    safePreview: redactSecrets({
      companies: records.companies,
      roles: records.roles,
      users: records.users.map((u) => ({
        ...u,
        passwordHash: u.passwordHash ? '[REDACTED]' : null,
      })),
    }),
  }
}

/**
 * Live SQL import — blocked unless all safety flags are set.
 * Does not run in automated tests.
 *
 * Requires:
 * - options.allowLiveImport === true
 * - process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT === '1'
 * - process.env.MIGRATION_IMPORT_APPROVED === '1'
 * - passwordGate.passed === true
 * - options.models { Company, Role, User } Sequelize models
 * - validation.ok
 */
async function importToSqlLive(exportPayload, options = {}) {
  if (options.allowLiveImport !== true) {
    const err = new Error('LIVE_SQL_IMPORT_BLOCKED')
    err.code = 'LIVE_SQL_IMPORT_BLOCKED'
    throw err
  }
  if (process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT !== '1') {
    const err = new Error('LIVE_SQL_IMPORT_ENV_BLOCKED')
    err.code = 'LIVE_SQL_IMPORT_ENV_BLOCKED'
    throw err
  }
  if (process.env.MIGRATION_IMPORT_APPROVED !== '1') {
    const err = new Error('LIVE_SQL_IMPORT_APPROVAL_REQUIRED')
    err.code = 'LIVE_SQL_IMPORT_APPROVAL_REQUIRED'
    throw err
  }

  assertPasswordGate(exportPayload.passwordGate || options.passwordGate)

  const plan = prepareImportPlan(exportPayload, options)
  if (!plan.ok) {
    const err = new Error('IMPORT_VALIDATION_FAILED')
    err.code = 'IMPORT_VALIDATION_FAILED'
    err.validation = plan.validation
    throw err
  }

  const { Company, Role, User } = options.models || {}
  if (!Company || !Role || !User) {
    throw new Error('Sequelize models not provided')
  }

  const sequelize = options.sequelize || Company.sequelize
  const transaction = await sequelize.transaction()
  try {
    for (const company of plan.records.companies) {
      await Company.findOrCreate({
        where: { id: company.id },
        defaults: {
          id: company.id,
          name: company.name,
          nameKey: company.nameKey,
          timezone: company.timezone,
          baseCurrency: company.baseCurrency,
          enabledCurrencies: company.enabledCurrencies,
          logoUrl: company.logoUrl,
          isActive: company.isActive,
          status: company.status,
          metaDefaultAssigneeUserId: null,
          emailReportsEnabled: false,
          createdAt: company.createdAt || new Date(),
          updatedAt: company.updatedAt || new Date(),
        },
        transaction,
      })
    }
    for (const role of plan.records.roles) {
      await Role.findOrCreate({
        where: { id: role.id },
        defaults: {
          id: role.id,
          companyId: role.companyId,
          key: role.key,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
          scope: role.scope,
          isSystem: role.isSystem,
          isProtected: role.isProtected,
          createdAt: role.createdAt || new Date(),
          updatedAt: role.updatedAt || new Date(),
        },
        transaction,
      })
    }
    for (const user of plan.records.users) {
      await User.findOrCreate({
        where: { id: user.id },
        defaults: {
          id: user.id,
          companyId: user.companyId,
          roleId: user.roleId,
          branchId: null,
          teamId: null,
          name: user.name,
          email: user.email,
          phone: user.phone,
          passwordHash: user.passwordHash,
          status: user.status,
          emailVerified: user.emailVerified,
          isInitialSuperAdmin: user.isInitialSuperAdmin,
          isPlatformOperator: user.isPlatformOperator,
          emailVerifyTokenHash: null,
          emailVerifyExpiresAt: null,
          resetTokenHash: null,
          resetExpiresAt: null,
          lastLoginAt: user.lastLoginAt,
          disabledAt: user.disabledAt,
          createdAt: user.createdAt || new Date(),
          updatedAt: user.updatedAt || new Date(),
        },
        transaction,
      })
    }
    await transaction.commit()
    return {
      ok: true,
      inserted: {
        companies: plan.records.companies.length,
        roles: plan.records.roles.length,
        users: plan.records.users.length,
      },
      idMap: plan.idMap,
    }
  } catch (error) {
    await transaction.rollback()
    throw error
  }
}

module.exports = {
  prepareImportPlan,
  importToSqlLive,
}
