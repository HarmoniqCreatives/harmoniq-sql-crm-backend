'use strict'

/**
 * Compare a prepared import plan against an optional destination snapshot.
 * Pure function — never writes to a database.
 *
 * destinationSnapshot shape (all optional arrays of ids/emails):
 * {
 *   companies: [{ id, nameKey }],
 *   roles: [{ id, companyId, key }],
 *   branches: [{ id, companyId, nameKey }],
 *   teams: [{ id, companyId, branchId, nameKey }],
 *   users: [{ id, companyId, email }],
 * }
 */

function normalizeNameKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
}

function reconcileAgainstDestination(records, destinationSnapshot = null) {
  const dest = destinationSnapshot || {}
  const companyById = new Map((dest.companies || []).map((row) => [row.id, row]))
  const roleById = new Map((dest.roles || []).map((row) => [row.id, row]))
  const branchById = new Map((dest.branches || []).map((row) => [row.id, row]))
  const teamById = new Map((dest.teams || []).map((row) => [row.id, row]))
  const userById = new Map((dest.users || []).map((row) => [row.id, row]))

  const companyByNormKey = new Map()
  for (const row of dest.companies || []) {
    companyByNormKey.set(normalizeNameKey(row.nameKey), row)
  }

  const rolesByCompanyKey = new Map(
    (dest.roles || []).map((row) => [`${row.companyId}:${String(row.key || '').toLowerCase()}`, row]),
  )
  const userEmailKeys = new Set(
    (dest.users || []).map((row) => `${row.companyId}:${String(row.email || '').toLowerCase()}`),
  )
  const userByEmailGlobal = new Map()
  for (const row of dest.users || []) {
    const email = String(row.email || '').toLowerCase()
    if (!email) continue
    if (!userByEmailGlobal.has(email)) userByEmailGlobal.set(email, [])
    userByEmailGlobal.get(email).push(row)
  }

  /** Planned company SQL id → destination company when nameKey logically matches. */
  const plannedCompanyToDest = new Map()
  for (const row of records.companies || []) {
    const hit = companyByNormKey.get(normalizeNameKey(row.nameKey))
    if (hit) plannedCompanyToDest.set(row.id, hit)
  }

  function classify(entity, rows, byId, extraMatch) {
    const ready = []
    const existing = []
    const conflicts = []
    for (const row of rows) {
      const found = byId.get(row.id)
      if (found) {
        existing.push({ entity, id: row.id, reason: 'id_exists' })
        continue
      }
      if (typeof extraMatch === 'function') {
        const conflict = extraMatch(row)
        if (conflict) {
          if (conflict.severity === 'existing') {
            existing.push(conflict)
          } else {
            conflicts.push(conflict)
          }
          continue
        }
      }
      ready.push({ entity, id: row.id })
    }
    return { ready, existing, conflicts }
  }

  const companies = classify('company', records.companies || [], companyById, (row) => {
    const hit = companyByNormKey.get(normalizeNameKey(row.nameKey))
    if (hit && hit.id !== row.id) {
      // Logical match — treat as existing (reuse; do not insert duplicate tenant)
      return {
        entity: 'company',
        id: row.id,
        reason: 'nameKey_logical_match',
        existingId: hit.id,
        existingNameKey: hit.nameKey,
        severity: 'existing',
      }
    }
    return null
  })

  const roles = classify('role', records.roles || [], roleById, (row) => {
    const destCompany = plannedCompanyToDest.get(row.companyId)
    if (!destCompany) return null
    const hit = rolesByCompanyKey.get(`${destCompany.id}:${String(row.key || '').toLowerCase()}`)
    if (hit) {
      return {
        entity: 'role',
        id: row.id,
        reason: 'role_key_exists_mapped_company',
        existingId: hit.id,
        key: row.key,
        severity: 'existing',
      }
    }
    return null
  })

  const branches = classify('branch', records.branches || [], branchById, (row) => {
    const destCompany = plannedCompanyToDest.get(row.companyId)
    if (!destCompany) return null
    const hit = [...branchById.values()].find(
      (b) =>
        b.companyId === destCompany.id &&
        normalizeNameKey(b.nameKey) === normalizeNameKey(row.nameKey),
    )
    if (hit) {
      return {
        entity: 'branch',
        id: row.id,
        reason: 'branch_nameKey_exists_mapped_company',
        existingId: hit.id,
        severity: 'existing',
      }
    }
    return null
  })

  const teams = classify('team', records.teams || [], teamById, (row) => {
    const destCompany = plannedCompanyToDest.get(row.companyId)
    if (!destCompany) return null
    const hit = [...teamById.values()].find(
      (t) =>
        t.companyId === destCompany.id &&
        normalizeNameKey(t.nameKey) === normalizeNameKey(row.nameKey),
    )
    if (hit) {
      return {
        entity: 'team',
        id: row.id,
        reason: 'team_nameKey_exists_mapped_company',
        existingId: hit.id,
        severity: 'existing',
      }
    }
    return null
  })

  const users = classify('user', records.users || [], userById, (row) => {
    const email = String(row.email || '').toLowerCase()
    const sameCompanyKey = `${row.companyId}:${email}`
    if (userEmailKeys.has(sameCompanyKey)) {
      return {
        entity: 'user',
        id: row.id,
        reason: 'email_exists_same_company',
        email: row.email,
        severity: 'conflict',
      }
    }

    const destCompany = plannedCompanyToDest.get(row.companyId)
    if (destCompany) {
      const mappedKey = `${destCompany.id}:${email}`
      if (userEmailKeys.has(mappedKey)) {
        const hit = (userByEmailGlobal.get(email) || []).find((u) => u.companyId === destCompany.id)
        return {
          entity: 'user',
          id: row.id,
          reason: 'email_exists_mapped_company',
          email: row.email,
          existingId: hit ? hit.id : undefined,
          severity: 'existing',
        }
      }
    }

    const globalHits = userByEmailGlobal.get(email) || []
    if (globalHits.length) {
      return {
        entity: 'user',
        id: row.id,
        reason: 'email_exists_other_company',
        email: row.email,
        existingId: globalHits[0].id,
        existingCompanyId: globalHits[0].companyId,
        severity: 'conflict',
      }
    }
    return null
  })

  return {
    sourceCounts: {
      companies: (records.companies || []).length,
      roles: (records.roles || []).length,
      branches: (records.branches || []).length,
      teams: (records.teams || []).length,
      users: (records.users || []).length,
    },
    destinationCounts: {
      companies: companyById.size,
      roles: roleById.size,
      branches: branchById.size,
      teams: teamById.size,
      users: userById.size,
    },
    readyToImport: {
      companies: companies.ready.length,
      roles: roles.ready.length,
      branches: branches.ready.length,
      teams: teams.ready.length,
      users: users.ready.length,
    },
    existingMatches: {
      companies: companies.existing.length,
      roles: roles.existing.length,
      branches: branches.existing.length,
      teams: teams.existing.length,
      users: users.existing.length,
    },
    conflicts: [
      ...companies.conflicts,
      ...roles.conflicts,
      ...branches.conflicts,
      ...teams.conflicts,
      ...users.conflicts,
    ],
    details: { companies, roles, branches, teams, users },
  }
}

module.exports = { reconcileAgainstDestination, normalizeNameKey }
