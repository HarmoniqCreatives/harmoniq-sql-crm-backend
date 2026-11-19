const { getModels } = require('../models')
const { security } = require('../config/security')
const {
  metaConnectionStatuses,
  metaPageStatuses,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { isUuid } = require('../utils/helpers')
const { decryptSecret } = require('../utils/metaSecrets')
const graphClient = require('./metaGraph')

/** @type {Map<string, { expiresAt: number, payload: object }>} */
const assetCache = new Map()
const ASSET_CACHE_TTL_MS = 60_000

function cacheKey(companyId, pageRowId, kind) {
  return `${companyId}:${pageRowId}:${kind}`
}

function readCache(companyId, pageRowId, kind) {
  const key = cacheKey(companyId, pageRowId, kind)
  const hit = assetCache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    assetCache.delete(key)
    return null
  }
  return hit.payload
}

function writeCache(companyId, pageRowId, kind, payload) {
  assetCache.set(cacheKey(companyId, pageRowId, kind), {
    expiresAt: Date.now() + ASSET_CACHE_TTL_MS,
    payload,
  })
}

/** Test helper — clears short-lived asset cache. */
function clearMetaAssetCache() {
  assetCache.clear()
}

/**
 * Loads a connected company page + decrypted page token.
 * @param {object} auth
 * @param {string} pageRowId
 */
async function loadConnectedPageTokens(auth, pageRowId) {
  const { MetaPage, MetaConnection } = getModels()
  if (!isUuid(pageRowId)) {
    throw new AppError(errors.metaPageNotFound, 404)
  }
  const page = await MetaPage.findOne({
    where: {
      id: pageRowId,
      companyId: auth.companyId,
    },
  })
  if (!page) {
    throw new AppError(errors.metaPageNotFound, 404)
  }
  if (page.status !== metaPageStatuses.connected) {
    throw new AppError(errors.metaTokenExpired, 401)
  }
  if (!page.tokenCipher) {
    throw new AppError(errors.metaTokenExpired, 401)
  }
  let pageToken = ''
  try {
    pageToken = decryptSecret(page.tokenCipher)
  } catch {
    throw new AppError(errors.metaTokenExpired, 401)
  }

  const connection = await MetaConnection.findOne({
    where: {
      id: page.connectionId,
      companyId: auth.companyId,
    },
  })
  if (!connection) {
    throw new AppError(errors.metaConnectionNotFound, 404)
  }

  let userToken = ''
  if (connection.tokenCipher && connection.status === metaConnectionStatuses.connected) {
    try {
      userToken = decryptSecret(connection.tokenCipher)
    } catch {
      userToken = ''
    }
  }

  const granted = Array.isArray(connection.grantedPermissions)
    ? connection.grantedPermissions
    : []

  return { page, connection, pageToken, userToken, granted }
}

function presentForm(row) {
  return {
    id: row.id ? String(row.id) : '',
    name: row.name ? String(row.name) : '',
    status: row.status ? String(row.status) : '',
    locale: row.locale ? String(row.locale) : '',
    leadsCount: typeof row.leads_count === 'number' ? row.leads_count : null,
    createdTime: row.created_time || null,
  }
}

function presentCampaign(row, adAccount) {
  return {
    id: row.id ? String(row.id) : '',
    name: row.name ? String(row.name) : '',
    effectiveStatus: row.effective_status ? String(row.effective_status) : '',
    status: row.status ? String(row.status) : '',
    objective: row.objective ? String(row.objective) : '',
    updatedTime: row.updated_time || null,
    adAccountId: adAccount.id || '',
    adAccountName: adAccount.name || '',
  }
}

function presentAd(row, adAccount) {
  return {
    id: row.id ? String(row.id) : '',
    name: row.name ? String(row.name) : '',
    effectiveStatus: row.effective_status ? String(row.effective_status) : '',
    status: row.status ? String(row.status) : '',
    campaignId: row.campaign_id ? String(row.campaign_id) : '',
    adsetId: row.adset_id ? String(row.adset_id) : '',
    updatedTime: row.updated_time || null,
    adAccountId: adAccount.id || '',
    adAccountName: adAccount.name || '',
  }
}

function normalizeAdAccount(row) {
  const id = row.id ? String(row.id) : ''
  const accountId = row.account_id != null ? String(row.account_id) : ''
  return {
    id: id || (accountId ? `act_${accountId}` : ''),
    accountId,
    name: row.name ? String(row.name) : '',
    accountStatus: row.account_status != null ? String(row.account_status) : '',
  }
}

/**
 * Resolves ad accounts for campaigns/ads listing.
 * Prefer page business owned/client accounts; fall back to me/adaccounts.
 *
 * @param {string} userToken
 * @param {string} facebookPageId
 * @returns {Promise<{ accounts: object[], source: string }>}
 */
async function resolveAdAccounts(userToken, facebookPageId) {
  const fromBusiness = await graphClient.readPageBusinessAdAccounts(userToken, facebookPageId)
  const businessAccounts = fromBusiness.map(normalizeAdAccount).filter((row) => row.id)
  if (businessAccounts.length > 0) {
    return { accounts: dedupeAccounts(businessAccounts), source: 'page_business' }
  }
  const fromUser = await graphClient.readUserAdAccounts(userToken, {
    pageLimit: security.metaSyncPageLimit,
  })
  const userAccounts = fromUser.map(normalizeAdAccount).filter((row) => row.id)
  return { accounts: dedupeAccounts(userAccounts), source: 'user_adaccounts' }
}

function dedupeAccounts(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, row)
  }
  return [...map.values()]
}

function requireAdsRead(granted) {
  if (!granted.includes('ads_read')) {
    throw new AppError(errors.metaPermissionMissing, 403, 'META_PERMISSION_MISSING', {
      action: 'RECONNECT',
      missing: ['ads_read'],
    })
  }
}

/**
 * @param {object} auth
 * @param {string} pageRowId
 */
async function listPageForms(auth, pageRowId) {
  const cached = readCache(auth.companyId, pageRowId, 'forms')
  if (cached) return cached

  const { page, pageToken } = await loadConnectedPageTokens(auth, pageRowId)
  let rows = []
  try {
    rows = await graphClient.readLeadgenForms(pageToken, page.pageId, {
      pageLimit: security.metaSyncPageLimit,
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(errors.metaExchangeFailed, 502)
  }

  const payload = {
    pageId: page.id,
    facebookPageId: page.pageId,
    pageName: page.name,
    forms: rows.map(presentForm),
  }
  writeCache(auth.companyId, pageRowId, 'forms', payload)
  return payload
}

/**
 * @param {object} auth
 * @param {string} pageRowId
 */
async function listPageCampaigns(auth, pageRowId) {
  const cached = readCache(auth.companyId, pageRowId, 'campaigns')
  if (cached) return cached

  const { page, userToken, granted } = await loadConnectedPageTokens(auth, pageRowId)
  if (!userToken) {
    throw new AppError(errors.metaTokenExpired, 401)
  }
  requireAdsRead(granted)

  let accounts = []
  let source = ''
  try {
    const resolved = await resolveAdAccounts(userToken, page.pageId)
    accounts = resolved.accounts
    source = resolved.source
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(errors.metaPermissionMissing, 403, 'META_PERMISSION_MISSING', {
      action: 'RECONNECT',
    })
  }

  if (accounts.length === 0) {
    throw new AppError(errors.metaAdAccountNotFound, 404, 'META_AD_ACCOUNT_NOT_FOUND')
  }

  const campaigns = []
  for (const account of accounts) {
    let rows = []
    try {
      rows = await graphClient.readAdAccountCampaigns(userToken, account.id, {
        pageLimit: security.metaSyncPageLimit,
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(errors.metaExchangeFailed, 502)
    }
    for (const row of rows) {
      campaigns.push(presentCampaign(row, account))
    }
  }

  const payload = {
    pageId: page.id,
    facebookPageId: page.pageId,
    pageName: page.name,
    adAccountSource: source,
    adAccounts: accounts.map((row) => ({
      id: row.id,
      name: row.name,
      accountStatus: row.accountStatus,
    })),
    campaigns,
  }
  writeCache(auth.companyId, pageRowId, 'campaigns', payload)
  return payload
}

/**
 * @param {object} auth
 * @param {string} pageRowId
 */
async function listPageAds(auth, pageRowId) {
  const cached = readCache(auth.companyId, pageRowId, 'ads')
  if (cached) return cached

  const { page, userToken, granted } = await loadConnectedPageTokens(auth, pageRowId)
  if (!userToken) {
    throw new AppError(errors.metaTokenExpired, 401)
  }
  requireAdsRead(granted)

  let accounts = []
  let source = ''
  try {
    const resolved = await resolveAdAccounts(userToken, page.pageId)
    accounts = resolved.accounts
    source = resolved.source
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(errors.metaPermissionMissing, 403, 'META_PERMISSION_MISSING', {
      action: 'RECONNECT',
    })
  }

  if (accounts.length === 0) {
    throw new AppError(errors.metaAdAccountNotFound, 404, 'META_AD_ACCOUNT_NOT_FOUND')
  }

  const ads = []
  for (const account of accounts) {
    let rows = []
    try {
      rows = await graphClient.readAdAccountAds(userToken, account.id, {
        pageLimit: security.metaSyncPageLimit,
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(errors.metaExchangeFailed, 502)
    }
    for (const row of rows) {
      ads.push(presentAd(row, account))
    }
  }

  const payload = {
    pageId: page.id,
    facebookPageId: page.pageId,
    pageName: page.name,
    adAccountSource: source,
    adAccounts: accounts.map((row) => ({
      id: row.id,
      name: row.name,
      accountStatus: row.accountStatus,
    })),
    ads,
  }
  writeCache(auth.companyId, pageRowId, 'ads', payload)
  return payload
}

module.exports = {
  clearMetaAssetCache,
  listPageAds,
  listPageCampaigns,
  listPageForms,
  loadConnectedPageTokens,
  resolveAdAccounts,
}
