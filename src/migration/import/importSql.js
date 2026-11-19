'use strict'

const { createIdMap } = require('../lib/idMap')
const { validateExportPayload, transformExportToSqlRecords } = require('../lib/validators')
const { assertPasswordGate } = require('../lib/passwordGate')
const { redactSecrets } = require('../lib/sanitize')
const { reconcileAgainstDestination } = require('../lib/reconcile')
const { applyDestinationRemap } = require('../lib/remap')

/**
 * Prepare SQL-ready payload without writing to the database.
 * When destinationSnapshot is provided, reconciles and remaps FKs/ids to existing
 * destination rows (no overwrite). Conflicts are reported and must block import.
 */
function prepareImportPlan(exportPayload, options = {}) {
  const validation = validateExportPayload(exportPayload)
  const idMap = createIdMap(options.idMapEntries || [])

  if (!validation.ok && options.allowInvalid !== true) {
    return {
      ok: false,
      validation,
      records: null,
      reconciliation: null,
      remaps: null,
      idMap: idMap.toJSON(),
    }
  }

  const rawRecords = transformExportToSqlRecords(exportPayload, idMap, {
    companyForceStatuses: options.companyForceStatuses || {},
  })

  const reconciliation = reconcileAgainstDestination(
    rawRecords,
    options.destinationSnapshot || null,
  )

  let records = rawRecords
  let remaps = { companies: 0, roles: 0, branches: 0, teams: 0, users: 0 }
  if (options.destinationSnapshot) {
    const remapped = applyDestinationRemap(rawRecords, reconciliation)
    records = remapped.records
    remaps = remapped.remaps
  }

  return {
    ok: validation.ok,
    validation,
    records,
    reconciliation,
    remaps,
    idMap: idMap.toJSON(),
    safePreview: redactSecrets({
      companies: records.companies,
      branches: records.branches,
      teams: records.teams,
      roles: records.roles,
      users: records.users.map((u) => ({
        ...u,
        passwordHash: u.passwordHash ? '[REDACTED]' : null,
      })),
    }),
  }
}

async function findOrCreateCounted(Model, where, defaults, transaction, counters, key) {
  const [row, created] = await Model.findOrCreate({
    where,
    defaults,
    transaction,
  })
  if (created) {
    counters.inserted[key] += 1
  } else {
    counters.existing[key] += 1
  }
  return row
}

/**
 * Live SQL import — blocked unless all safety flags are set.
 * Does not overwrite existing rows (findOrCreate by primary key only).
 *
 * Requires:
 * - options.allowLiveImport === true
 * - process.env.MIGRATION_ALLOW_LIVE_SQL_IMPORT === '1'
 * - process.env.MIGRATION_IMPORT_APPROVED === '1'
 * - passwordGate.passed === true
 * - options.models { Company, Role, User, Branch?, Team? }
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

  if (!options.destinationSnapshot) {
    const err = new Error('IMPORT_DESTINATION_SNAPSHOT_REQUIRED')
    err.code = 'IMPORT_DESTINATION_SNAPSHOT_REQUIRED'
    throw err
  }

  const plan = prepareImportPlan(exportPayload, options)
  if (!plan.ok) {
    const err = new Error('IMPORT_VALIDATION_FAILED')
    err.code = 'IMPORT_VALIDATION_FAILED'
    err.validation = plan.validation
    throw err
  }

  // Never bypass conflicts automatically.
  if (plan.reconciliation && plan.reconciliation.conflicts.length > 0) {
    const err = new Error('IMPORT_DESTINATION_CONFLICTS')
    err.code = 'IMPORT_DESTINATION_CONFLICTS'
    err.reconciliation = plan.reconciliation
    throw err
  }

  const { Company, Role, User, Branch, Team } = options.models || {}
  if (!Company || !Role || !User) {
    throw new Error('Sequelize models not provided (Company, Role, User required)')
  }
  if ((plan.records.branches.length > 0 || plan.records.teams.length > 0) && (!Branch || !Team)) {
    throw new Error('Branch and Team models required when import includes branches/teams')
  }

  const sequelize = options.sequelize || Company.sequelize
  const counters = {
    inserted: { companies: 0, branches: 0, teams: 0, roles: 0, users: 0 },
    existing: { companies: 0, branches: 0, teams: 0, roles: 0, users: 0 },
  }

  const transaction = await sequelize.transaction()
  try {
    for (const company of plan.records.companies) {
      await findOrCreateCounted(Company, { id: company.id }, {
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
      }, transaction, counters, 'companies')
    }

    for (const role of plan.records.roles) {
      await findOrCreateCounted(Role, { id: role.id }, {
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
      }, transaction, counters, 'roles')
    }

    if (Branch) {
      for (const branch of plan.records.branches) {
        await findOrCreateCounted(Branch, { id: branch.id }, {
          id: branch.id,
          companyId: branch.companyId,
          name: branch.name,
          nameKey: branch.nameKey,
          timezone: branch.timezone,
          isActive: branch.isActive,
          createdAt: branch.createdAt || new Date(),
          updatedAt: branch.updatedAt || new Date(),
        }, transaction, counters, 'branches')
      }
    }

    if (Team) {
      for (const team of plan.records.teams) {
        await findOrCreateCounted(Team, { id: team.id }, {
          id: team.id,
          companyId: team.companyId,
          branchId: team.branchId,
          name: team.name,
          nameKey: team.nameKey,
          managerUserId: null,
          isActive: team.isActive,
          createdAt: team.createdAt || new Date(),
          updatedAt: team.updatedAt || new Date(),
        }, transaction, counters, 'teams')
      }
    }

    for (const user of plan.records.users) {
      await findOrCreateCounted(User, { id: user.id }, {
        id: user.id,
        companyId: user.companyId,
        roleId: user.roleId,
        branchId: user.branchId,
        teamId: user.teamId,
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
      }, transaction, counters, 'users')
    }

    // Second pass: set team managers without overwriting unrelated fields on existing teams
    // only when the team was just inserted or still has null manager.
    if (Team) {
      for (const team of plan.records.teams) {
        if (!team.managerUserId) continue
        const existing = await Team.findByPk(team.id, { transaction })
        if (existing && !existing.managerUserId) {
          existing.managerUserId = team.managerUserId
          await existing.save({ transaction })
        }
      }
    }

    await transaction.commit()
    return {
      ok: true,
      inserted: counters.inserted,
      existing: counters.existing,
      remaps: plan.remaps,
      planned: {
        companies: plan.records.companies.length,
        branches: plan.records.branches.length,
        teams: plan.records.teams.length,
        roles: plan.records.roles.length,
        users: plan.records.users.length,
      },
      reconciliation: plan.reconciliation,
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
