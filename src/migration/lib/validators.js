'use strict'

const { mapRolePermissions } = require('./permissionMap')
const {
  mapCompanyActivation,
  mapUserStatus,
  mapEmailVerified,
  mapRoleScope,
} = require('./statusMap')
const { isBcryptHashFormat } = require('./passwordGate')
const { summarizeUserForReport } = require('./sanitize')

function oid(value) {
  if (value == null) {
    return ''
  }
  if (typeof value === 'object' && value.toString) {
    return String(value)
  }
  return String(value)
}

/**
 * Dry-run validation for a Mongo-shaped export payload.
 *
 * @param {{
 *   companies: object[],
 *   roles: object[],
 *   users: object[],
 *   companyActiveHints?: Record<string, boolean>,
 *   passwordGate?: { passed: boolean, testedAt?: string },
 * }} exportPayload
 */
function validateExportPayload(exportPayload) {
  const errors = []
  const warnings = []
  const companies = exportPayload.companies || []
  const roles = exportPayload.roles || []
  const users = exportPayload.users || []
  const hints = exportPayload.companyActiveHints || {}
  const passwordGate = exportPayload.passwordGate || { passed: false }

  const companyIds = new Set()
  const nameKeys = new Map()
  const rolesByCompany = new Map()
  const roleIds = new Map()
  const emailsByCompany = new Map()
  const initialSaByCompany = new Map()

  // --- Companies ---
  for (const company of companies) {
    const id = oid(company._id || company.id)
    if (!id) {
      errors.push({ code: 'company_missing_id', message: 'Company missing _id' })
      continue
    }
    if (companyIds.has(id)) {
      errors.push({ code: 'company_duplicate_id', message: `Duplicate company id ${id}`, companyMongoId: id })
    }
    companyIds.add(id)

    const name = company.name || ''
    if (!name) {
      errors.push({ code: 'company_name_required', companyMongoId: id, message: 'Company name required' })
    } else if (String(name).length > 160) {
      errors.push({ code: 'company_name_too_long', companyMongoId: id, message: 'Company name exceeds 160 chars' })
    }

    const nameKey = company.nameKey || String(name).trim().toLowerCase()
    if (!nameKey) {
      errors.push({ code: 'company_name_key_required', companyMongoId: id, message: 'nameKey required' })
    } else if (String(nameKey).length > 180) {
      errors.push({ code: 'company_name_key_too_long', companyMongoId: id, message: 'nameKey exceeds 180 chars' })
    } else if (nameKeys.has(nameKey)) {
      errors.push({
        code: 'company_name_key_conflict',
        companyMongoId: id,
        message: `nameKey conflict with ${nameKeys.get(nameKey)}`,
      })
    } else {
      nameKeys.set(nameKey, id)
    }

    if (!Array.isArray(company.enabledCurrencies) || company.enabledCurrencies.length === 0) {
      errors.push({ code: 'company_currencies_required', companyMongoId: id, message: 'enabledCurrencies required' })
    }

    if (hints[id] === false) {
      warnings.push({
        code: 'company_marked_inactive',
        companyMongoId: id,
        message: 'Company hint isActive=false → PENDING_VERIFICATION unless forceStatus set',
      })
    }
  }

  // --- Roles ---
  for (const role of roles) {
    const id = oid(role._id || role.id)
    const companyId = oid(role.companyId)
    if (!id) {
      errors.push({ code: 'role_missing_id', message: 'Role missing _id' })
      continue
    }
    if (!companyIds.has(companyId)) {
      errors.push({
        code: 'role_missing_company',
        roleMongoId: id,
        companyMongoId: companyId,
        message: 'Role company not in export',
      })
      continue
    }
    if (roleIds.has(id)) {
      errors.push({ code: 'role_duplicate_id', roleMongoId: id, message: 'Duplicate role id' })
    }
    roleIds.set(id, companyId)

    const key = role.key || ''
    if (!key || String(key).length > 64) {
      errors.push({ code: 'role_key_invalid', roleMongoId: id, message: 'Invalid role key' })
    }
    const bucket = rolesByCompany.get(companyId) || new Set()
    if (bucket.has(key)) {
      errors.push({
        code: 'role_key_duplicate',
        roleMongoId: id,
        companyMongoId: companyId,
        message: `Duplicate role key ${key}`,
      })
    }
    bucket.add(key)
    rolesByCompany.set(companyId, bucket)

    if (!mapRoleScope(role.scope)) {
      errors.push({ code: 'role_scope_invalid', roleMongoId: id, message: `Invalid scope ${role.scope}` })
    }
    if (role.name && String(role.name).length > 120) {
      errors.push({ code: 'role_name_too_long', roleMongoId: id, message: 'Role name exceeds 120' })
    }

    const mapped = mapRolePermissions(role.permissions || [], {
      key: role.key,
      isProtected: role.isProtected,
    })
    for (const omitted of mapped.omitted) {
      warnings.push({
        code: 'permission_omitted',
        roleMongoId: id,
        companyMongoId: companyId,
        message: `Unknown permission omitted: ${omitted}`,
      })
    }
  }

  // --- Users ---
  for (const user of users) {
    const id = oid(user._id || user.id)
    const companyId = oid(user.companyId)
    const roleId = oid(user.roleId)
    const summary = summarizeUserForReport({
      mongoId: id,
      email: user.email,
      companyMongoId: companyId,
      status: user.status,
      emailVerified: user.emailVerified,
      passwordHash: user.passwordHash,
    })

    if (!id) {
      errors.push({ code: 'user_missing_id', message: 'User missing _id' })
      continue
    }
    if (!companyIds.has(companyId)) {
      errors.push({
        code: 'user_missing_company',
        ...summary,
        message: 'User company not in export',
      })
      continue
    }
    if (!roleIds.has(roleId)) {
      errors.push({
        code: 'user_missing_role',
        ...summary,
        roleMongoId: roleId,
        message: 'User role not in export',
      })
    } else if (roleIds.get(roleId) !== companyId) {
      errors.push({
        code: 'user_cross_company_role',
        ...summary,
        roleMongoId: roleId,
        message: 'User role belongs to a different company',
      })
    }

    const email = String(user.email || '').trim().toLowerCase()
    if (!email) {
      errors.push({ code: 'user_email_required', ...summary, message: 'Email required' })
    } else if (email.length > 190) {
      errors.push({ code: 'user_email_too_long', ...summary, message: 'Email exceeds 190' })
    } else {
      const emailBucket = emailsByCompany.get(companyId) || new Set()
      if (emailBucket.has(email)) {
        errors.push({
          code: 'user_email_duplicate',
          ...summary,
          message: `Duplicate email within company: ${email}`,
        })
      }
      emailBucket.add(email)
      emailsByCompany.set(companyId, emailBucket)
    }

    if (user.name && String(user.name).length > 120) {
      errors.push({ code: 'user_name_too_long', ...summary, message: 'Name exceeds 120' })
    }
    if (user.phone && String(user.phone).length > 32) {
      errors.push({ code: 'user_phone_too_long', ...summary, message: 'Phone exceeds 32' })
    }

    const sqlStatus = mapUserStatus(user.status)
    if (!sqlStatus) {
      errors.push({ code: 'user_status_invalid', ...summary, message: `Invalid status ${user.status}` })
    }

    if (!isBcryptHashFormat(user.passwordHash)) {
      errors.push({
        code: 'user_password_hash_invalid',
        ...summary,
        message: 'passwordHash is missing or not a bcrypt digest',
      })
    }

    if (user.isInitialSuperAdmin === true) {
      const list = initialSaByCompany.get(companyId) || []
      list.push(id)
      initialSaByCompany.set(companyId, list)
    }

    const mappedVerified = mapEmailVerified(user.emailVerified, sqlStatus)
    if (user.emailVerified === false && sqlStatus === 'ACTIVE') {
      warnings.push({
        code: 'active_user_unverified',
        ...summary,
        message: 'ACTIVE user has emailVerified=false (will not login until verified)',
      })
    }
    if (user.emailVerified == null && sqlStatus === 'ACTIVE' && mappedVerified === true) {
      warnings.push({
        code: 'email_verified_coerced_true',
        ...summary,
        message: 'emailVerified unset → true for active staff (BD-2)',
      })
    }
  }

  // BD-6: multiple initial super admins
  for (const [companyId, list] of initialSaByCompany.entries()) {
    if (list.length > 1) {
      errors.push({
        code: 'initial_super_admin_conflict',
        companyMongoId: companyId,
        userMongoIds: list,
        message: `Multiple isInitialSuperAdmin=true (${list.length}); manual review required`,
      })
    }
  }

  if (!passwordGate.passed) {
    warnings.push({
      code: 'password_gate_not_passed',
      message: 'Password compatibility gate not passed — import must not copy hashes until staging test succeeds',
    })
  }

  const counts = {
    companies: companies.length,
    roles: roles.length,
    users: users.length,
    rolesPerCompany: Object.fromEntries(
      [...rolesByCompany.entries()].map(([cid, set]) => [cid, set.size]),
    ),
    usersPerCompany: {},
  }
  for (const user of users) {
    const cid = oid(user.companyId)
    counts.usersPerCompany[cid] = (counts.usersPerCompany[cid] || 0) + 1
  }

  return {
    ok: errors.length === 0,
    counts,
    errors,
    warnings,
    passwordGate: {
      passed: Boolean(passwordGate.passed),
      testedAt: passwordGate.testedAt || null,
    },
  }
}

/**
 * Build SQL-ready records from a validated export (pure transform).
 * Caller must ensure validateExportPayload.ok (except when forceTransform for unit tests).
 */
function transformExportToSqlRecords(exportPayload, idMap, options = {}) {
  const hints = exportPayload.companyActiveHints || {}
  const forceStatuses = options.companyForceStatuses || {}
  const companiesOut = []
  const rolesOut = []
  const usersOut = []

  for (const company of exportPayload.companies || []) {
    const mongoId = oid(company._id || company.id)
    const sqlId = idMap.ensure('company', mongoId, mongoId)
    const activation = mapCompanyActivation({
      isActiveHint: hints[mongoId],
      forceStatus: forceStatuses[mongoId] || null,
    })
    companiesOut.push({
      id: sqlId,
      mongoId,
      name: company.name,
      nameKey: company.nameKey || String(company.name || '').trim().toLowerCase(),
      timezone: company.timezone,
      baseCurrency: company.baseCurrency,
      enabledCurrencies: company.enabledCurrencies,
      logoUrl: null,
      isActive: activation.isActive,
      status: activation.status,
      metaDefaultAssigneeUserId: null,
      emailReportsEnabled: false,
      createdAt: company.createdAt || null,
      updatedAt: company.updatedAt || null,
    })
  }

  for (const role of exportPayload.roles || []) {
    const mongoId = oid(role._id || role.id)
    const companyMongoId = oid(role.companyId)
    const companySqlId = idMap.get('company', companyMongoId)
    if (!companySqlId) {
      throw new Error(`Missing company mapping for role ${mongoId}`)
    }
    const sqlId = idMap.ensure('role', mongoId, companyMongoId)
    const mapped = mapRolePermissions(role.permissions || [], {
      key: role.key,
      isProtected: role.isProtected,
    })
    rolesOut.push({
      id: sqlId,
      mongoId,
      companyId: companySqlId,
      companyMongoId,
      key: role.key,
      name: role.name,
      description: role.description || '',
      permissions: mapped.permissions,
      scope: mapRoleScope(role.scope),
      isSystem: Boolean(role.isSystem),
      isProtected: Boolean(role.isProtected),
      permissionMeta: {
        omitted: mapped.omitted,
        expandedFrom: mapped.expandedFrom,
      },
      createdAt: role.createdAt || null,
      updatedAt: role.updatedAt || null,
    })
  }

  for (const user of exportPayload.users || []) {
    const mongoId = oid(user._id || user.id)
    const companyMongoId = oid(user.companyId)
    const roleMongoId = oid(user.roleId)
    const companySqlId = idMap.get('company', companyMongoId)
    const roleSqlId = idMap.get('role', roleMongoId)
    const cross = idMap.assertSameCompany('role', roleMongoId, companyMongoId)
    if (!companySqlId || !roleSqlId || !cross.ok) {
      throw new Error(`Invalid company/role mapping for user ${mongoId}`)
    }
    const sqlId = idMap.ensure('user', mongoId, companyMongoId)
    const sqlStatus = mapUserStatus(user.status)
    usersOut.push({
      id: sqlId,
      mongoId,
      companyId: companySqlId,
      companyMongoId,
      roleId: roleSqlId,
      roleMongoId,
      branchId: null,
      teamId: null,
      name: user.name,
      email: String(user.email || '').trim().toLowerCase(),
      phone: user.phone || null,
      passwordHash: user.passwordHash,
      status: sqlStatus,
      emailVerified: mapEmailVerified(user.emailVerified, sqlStatus),
      isInitialSuperAdmin: Boolean(user.isInitialSuperAdmin),
      isPlatformOperator: Boolean(user.isPlatformOperator),
      emailVerifyTokenHash: null,
      emailVerifyExpiresAt: null,
      resetTokenHash: null,
      resetExpiresAt: null,
      lastLoginAt: user.lastLoginAt || null,
      disabledAt: user.disabledAt || (sqlStatus === 'DISABLED' ? user.disabledAt || null : null),
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
    })
  }

  return { companies: companiesOut, roles: rolesOut, users: usersOut }
}

module.exports = {
  validateExportPayload,
  transformExportToSqlRecords,
  oid,
}
