'use strict'

const { normalizeNameKey } = require('./reconcile')

/**
 * Rewrite planned SQL records to reuse destination primary keys / FKs when
 * reconciliation marked logical matches as existing.
 *
 * Pure function — does not write to the database.
 * Must only be called after conflicts have been reviewed (import refuses conflicts).
 *
 * @param {object} records  transform output
 * @param {object} reconciliation  reconcileAgainstDestination output
 * @returns {{ records: object, remaps: object }}
 */
function applyDestinationRemap(records, reconciliation) {
  const details = (reconciliation && reconciliation.details) || {}
  const companyIdMap = new Map()
  const roleIdMap = new Map()
  const branchIdMap = new Map()
  const teamIdMap = new Map()
  const userIdMap = new Map()

  for (const row of details.companies?.existing || []) {
    if (row.existingId) companyIdMap.set(row.id, row.existingId)
  }
  for (const row of details.roles?.existing || []) {
    if (row.existingId) roleIdMap.set(row.id, row.existingId)
  }
  for (const row of details.branches?.existing || []) {
    if (row.existingId) branchIdMap.set(row.id, row.existingId)
  }
  for (const row of details.teams?.existing || []) {
    if (row.existingId) teamIdMap.set(row.id, row.existingId)
  }
  for (const row of details.users?.existing || []) {
    if (row.existingId) userIdMap.set(row.id, row.existingId)
  }

  function mapId(map, id) {
    if (id == null) return id
    return map.has(id) ? map.get(id) : id
  }

  const companies = (records.companies || []).map((row) => ({
    ...row,
    id: mapId(companyIdMap, row.id),
    nameKey: normalizeNameKey(row.nameKey || row.name),
    remappedFromId: companyIdMap.has(row.id) ? row.id : undefined,
  }))

  const roles = (records.roles || []).map((row) => ({
    ...row,
    id: mapId(roleIdMap, row.id),
    companyId: mapId(companyIdMap, row.companyId),
    remappedFromId: roleIdMap.has(row.id) ? row.id : undefined,
  }))

  const branches = (records.branches || []).map((row) => ({
    ...row,
    id: mapId(branchIdMap, row.id),
    companyId: mapId(companyIdMap, row.companyId),
    nameKey: normalizeNameKey(row.nameKey || row.name),
    remappedFromId: branchIdMap.has(row.id) ? row.id : undefined,
  }))

  const teams = (records.teams || []).map((row) => ({
    ...row,
    id: mapId(teamIdMap, row.id),
    companyId: mapId(companyIdMap, row.companyId),
    branchId: mapId(branchIdMap, row.branchId),
    managerUserId: mapId(userIdMap, row.managerUserId),
    nameKey: normalizeNameKey(row.nameKey || row.name),
    remappedFromId: teamIdMap.has(row.id) ? row.id : undefined,
  }))

  const users = (records.users || []).map((row) => ({
    ...row,
    id: mapId(userIdMap, row.id),
    companyId: mapId(companyIdMap, row.companyId),
    roleId: mapId(roleIdMap, row.roleId),
    branchId: mapId(branchIdMap, row.branchId),
    teamId: mapId(teamIdMap, row.teamId),
    remappedFromId: userIdMap.has(row.id) ? row.id : undefined,
  }))

  return {
    records: { companies, branches, teams, roles, users },
    remaps: {
      companies: companyIdMap.size,
      roles: roleIdMap.size,
      branches: branchIdMap.size,
      teams: teamIdMap.size,
      users: userIdMap.size,
    },
  }
}

module.exports = {
  applyDestinationRemap,
}
