#!/usr/bin/env node
/**
 * Backfill leads.metaCreatedAt from meta_webhook_ingestions.facebookCreatedAt.
 *
 * Safety:
 * - Targets only Meta leads (non-empty metaLeadId) with metaCreatedAt IS NULL
 * - Never overwrites an existing metaCreatedAt
 * - Never writes dates onto manual leads (no metaLeadId)
 * - Skips leads with conflicting ingestion timestamps
 * - Default mode is dry-run; --apply writes
 * - Refuses non-local database hosts
 *
 * Usage:
 *   node src/scripts/backfillLeadMetaCreatedAt.js
 *   node src/scripts/backfillLeadMetaCreatedAt.js --dry-run
 *   node src/scripts/backfillLeadMetaCreatedAt.js --apply
 *   node src/scripts/backfillLeadMetaCreatedAt.js --apply --company-id=<uuid>
 */
const { Op } = require('sequelize')
const { getModels } = require('../models')
const { readEnv } = require('../config/env')

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    companyId: '',
  }
  for (const raw of argv) {
    if (raw === '--apply') {
      args.apply = true
      args.dryRun = false
      continue
    }
    if (raw === '--dry-run') {
      args.apply = false
      args.dryRun = true
      continue
    }
    if (raw.startsWith('--company-id=')) {
      args.companyId = raw.slice('--company-id='.length).trim()
      continue
    }
    if (raw === '--help' || raw === '-h') {
      args.help = true
    }
  }
  return args
}

function assertLocalDatabaseHost() {
  const env = readEnv()
  const host = String(env.db.host || '').toLowerCase()
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run against non-local DB host "${env.db.host}". `
      + 'This script is local-only unless the host is 127.0.0.1/localhost.',
    )
  }
  return {
    host: env.db.host,
    name: env.db.name,
    nodeEnv: process.env.NODE_ENV || '',
  }
}

/**
 * Deterministic timestamp pick from candidate ingestion rows.
 * Same timestamp across rows → use it.
 * Differing timestamps → conflict (null + conflict flag).
 *
 * @param {Array<{ id: string, leadId: string|null, facebookCreatedAt: Date|string, createdAt?: Date|string }>} rows
 * @param {string} leadId
 * @returns {{ status: 'matched'|'conflict'|'none', metaCreatedAt: Date|null, matchMethod: string, ingestionIds: string[], distinctTimestamps: string[] }}
 */
function resolveMetaCreatedAt(rows, leadId) {
  const usable = (rows || []).filter((row) => row && row.facebookCreatedAt)
  if (!usable.length) {
    return {
      status: 'none',
      metaCreatedAt: null,
      matchMethod: '',
      ingestionIds: [],
      distinctTimestamps: [],
    }
  }

  const byTime = new Map()
  for (const row of usable) {
    const date = row.facebookCreatedAt instanceof Date
      ? row.facebookCreatedAt
      : new Date(row.facebookCreatedAt)
    if (Number.isNaN(date.getTime())) continue
    const key = date.toISOString()
    if (!byTime.has(key)) byTime.set(key, [])
    byTime.get(key).push(row)
  }

  const distinctTimestamps = [...byTime.keys()].sort()
  if (!distinctTimestamps.length) {
    return {
      status: 'none',
      metaCreatedAt: null,
      matchMethod: '',
      ingestionIds: usable.map((row) => row.id),
      distinctTimestamps: [],
    }
  }

  if (distinctTimestamps.length > 1) {
    return {
      status: 'conflict',
      metaCreatedAt: null,
      matchMethod: '',
      ingestionIds: usable.map((row) => row.id).sort(),
      distinctTimestamps,
    }
  }

  const chosenKey = distinctTimestamps[0]
  const chosenRows = byTime.get(chosenKey)
  const hasLeadIdMatch = chosenRows.some((row) => row.leadId && String(row.leadId) === String(leadId))
  return {
    status: 'matched',
    metaCreatedAt: new Date(chosenKey),
    matchMethod: hasLeadIdMatch ? 'leadId' : 'companyId+leadgenId',
    ingestionIds: chosenRows.map((row) => row.id).sort(),
    distinctTimestamps,
  }
}

/**
 * @param {import('sequelize').Model} Lead
 * @param {import('sequelize').Model} MetaWebhookIngestion
 * @param {{ companyId?: string }} options
 */
async function loadEligibleLeads(Lead, MetaWebhookIngestion, options = {}) {
  const where = {
    metaCreatedAt: null,
    // Meta imports always set metaLeadId; exclude manual even if a fixture stamped an id.
    source: { [Op.ne]: 'manual' },
    metaLeadId: {
      [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }],
    },
  }
  if (options.companyId) {
    where.companyId = options.companyId
  }

  return Lead.findAll({
    where,
    attributes: ['id', 'companyId', 'metaLeadId', 'source', 'number', 'metaCreatedAt'],
    order: [['companyId', 'ASC'], ['number', 'ASC']],
  })
}

/**
 * Load ingestions that can contribute a facebookCreatedAt for the given leads.
 * @param {import('sequelize').Model} MetaWebhookIngestion
 * @param {Array<{ id: string, companyId: string, metaLeadId: string }>} leads
 */
async function loadCandidateIngestions(MetaWebhookIngestion, leads) {
  if (!leads.length) return []
  const leadIds = leads.map((lead) => lead.id)
  const companyIds = [...new Set(leads.map((lead) => lead.companyId))]
  const metaLeadIds = [...new Set(leads.map((lead) => lead.metaLeadId).filter(Boolean))]

  return MetaWebhookIngestion.findAll({
    where: {
      facebookCreatedAt: { [Op.ne]: null },
      [Op.or]: [
        { leadId: { [Op.in]: leadIds } },
        {
          companyId: { [Op.in]: companyIds },
          leadgenId: { [Op.in]: metaLeadIds },
        },
      ],
    },
    attributes: ['id', 'companyId', 'leadId', 'leadgenId', 'facebookCreatedAt', 'createdAt'],
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
  })
}

/**
 * Index ingestions for O(1) lead lookup.
 * @param {Array<{ id: string, companyId: string|null, leadId: string|null, leadgenId: string, facebookCreatedAt: Date }>} ingestions
 */
function indexIngestions(ingestions) {
  const byLeadId = new Map()
  const byCompanyLeadgen = new Map()

  for (const row of ingestions) {
    if (row.leadId) {
      if (!byLeadId.has(row.leadId)) byLeadId.set(row.leadId, [])
      byLeadId.get(row.leadId).push(row)
    }
    if (row.companyId && row.leadgenId) {
      const key = `${row.companyId}::${row.leadgenId}`
      if (!byCompanyLeadgen.has(key)) byCompanyLeadgen.set(key, [])
      byCompanyLeadgen.get(key).push(row)
    }
  }

  return { byLeadId, byCompanyLeadgen }
}

function candidatesForLead(lead, index) {
  const seen = new Map()
  const add = (rows) => {
    for (const row of rows || []) {
      if (!seen.has(row.id)) seen.set(row.id, row)
    }
  }
  add(index.byLeadId.get(lead.id))
  add(index.byCompanyLeadgen.get(`${lead.companyId}::${lead.metaLeadId}`))
  return [...seen.values()]
}

/**
 * @param {{ apply: boolean, companyId?: string }} options
 */
async function runBackfill(options) {
  const db = assertLocalDatabaseHost()
  const { sequelize, Lead, MetaWebhookIngestion } = getModels()
  await sequelize.authenticate()

  const leads = await loadEligibleLeads(Lead, MetaWebhookIngestion, {
    companyId: options.companyId || '',
  })
  const ingestions = await loadCandidateIngestions(MetaWebhookIngestion, leads)
  const index = indexIngestions(ingestions)

  const matched = []
  const unmatched = []
  const conflicts = []

  for (const lead of leads) {
    const candidates = candidatesForLead(lead, index)
    const resolved = resolveMetaCreatedAt(candidates, lead.id)
    if (resolved.status === 'matched') {
      matched.push({
        leadId: lead.id,
        companyId: lead.companyId,
        number: lead.number,
        metaLeadId: lead.metaLeadId,
        source: lead.source,
        metaCreatedAt: resolved.metaCreatedAt.toISOString(),
        matchMethod: resolved.matchMethod,
        ingestionIds: resolved.ingestionIds,
      })
    } else if (resolved.status === 'conflict') {
      conflicts.push({
        leadId: lead.id,
        companyId: lead.companyId,
        number: lead.number,
        metaLeadId: lead.metaLeadId,
        ingestionIds: resolved.ingestionIds,
        distinctTimestamps: resolved.distinctTimestamps,
      })
    } else {
      unmatched.push({
        leadId: lead.id,
        companyId: lead.companyId,
        number: lead.number,
        metaLeadId: lead.metaLeadId,
        source: lead.source,
      })
    }
  }

  let updated = 0
  if (options.apply && matched.length) {
    await sequelize.transaction(async (transaction) => {
      for (const row of matched) {
        const [count] = await Lead.update(
          { metaCreatedAt: new Date(row.metaCreatedAt) },
          {
            where: {
              id: row.leadId,
              metaCreatedAt: null,
              source: { [Op.ne]: 'manual' },
              metaLeadId: {
                [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }],
              },
            },
            transaction,
          },
        )
        updated += count
      }
    })
  }

  const report = {
    event: 'lead_meta_created_at_backfill',
    mode: options.apply ? 'apply' : 'dry-run',
    database: db,
    companyIdFilter: options.companyId || null,
    totals: {
      eligibleMetaLeads: leads.length,
      withMatchingIngestionTimestamp: matched.length,
      withoutMatchingTimestamp: unmatched.length,
      duplicateConflictingMatches: conflicts.length,
      updated: options.apply ? updated : 0,
    },
    matchedSample: matched.slice(0, 20),
    unmatchedSample: unmatched.slice(0, 20),
    conflictSample: conflicts.slice(0, 20),
  }

  return report
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage:
  node src/scripts/backfillLeadMetaCreatedAt.js [--dry-run|--apply] [--company-id=<uuid>]

Default: --dry-run
Refuses non-local DB hosts.
Never overwrites existing metaCreatedAt. Manual leads are excluded.`)
    return
  }

  const report = await runBackfill({
    apply: args.apply,
    companyId: args.companyId,
  })
  console.log(JSON.stringify(report, null, 2))

  const { sequelize } = getModels()
  await sequelize.close()
}

module.exports = {
  parseArgs,
  resolveMetaCreatedAt,
  runBackfill,
  assertLocalDatabaseHost,
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(JSON.stringify({
      event: 'lead_meta_created_at_backfill_failed',
      message: error.message,
    }))
    try {
      const { sequelize } = getModels()
      await sequelize.close()
    } catch (_) {
      // ignore close errors after failure
    }
    process.exitCode = 1
  })
}
