'use strict'

const { companyStatuses, userStatuses } = require('../../utils/enums')

/**
 * Approved BD decisions for company / user activation.
 *
 * BD-1: Active companies → ACTIVE + isActive=true; others keep intentional state.
 * BD-2: emailVerified explicit false → false; unset + active staff → true.
 * BD-3: disabled users → DISABLED.
 */

/**
 * @param {{ isActiveHint?: boolean|null, forceStatus?: string|null }} options
 *   isActiveHint: from operator list / dry-run config (true = live tenant).
 *   forceStatus: optional override ACTIVE|DISABLED|PENDING_VERIFICATION
 */
function mapCompanyActivation(options = {}) {
  if (options.forceStatus === companyStatuses.disabled) {
    return { status: companyStatuses.disabled, isActive: false }
  }
  if (options.forceStatus === companyStatuses.pendingVerification) {
    return { status: companyStatuses.pendingVerification, isActive: false }
  }
  if (options.forceStatus === companyStatuses.active || options.isActiveHint !== false) {
    // Default for this phase: treat company as active unless explicitly marked otherwise.
    return { status: companyStatuses.active, isActive: true }
  }
  return { status: companyStatuses.pendingVerification, isActive: false }
}

/**
 * Mongo userStatuses: invited | active | disabled
 * SQL: PENDING | ACTIVE | DISABLED
 */
function mapUserStatus(mongoStatus) {
  const value = String(mongoStatus || '').toLowerCase()
  if (value === 'disabled') {
    return userStatuses.disabled
  }
  if (value === 'invited' || value === 'pending') {
    return userStatuses.pending
  }
  if (value === 'active') {
    return userStatuses.active
  }
  return null
}

/**
 * BD-2: explicit false stays false; unset/null/undefined → true for ACTIVE staff;
 * non-active users keep false unless explicitly true.
 *
 * @param {boolean|null|undefined} emailVerified
 * @param {string} sqlUserStatus
 */
function mapEmailVerified(emailVerified, sqlUserStatus) {
  if (emailVerified === false) {
    return false
  }
  if (emailVerified === true) {
    return true
  }
  // unset
  if (sqlUserStatus === userStatuses.active) {
    return true
  }
  return false
}

function mapRoleScope(mongoScope) {
  const value = String(mongoScope || '').toLowerCase()
  const map = {
    own: 'OWN',
    team: 'TEAM',
    branch: 'BRANCH',
    company: 'COMPANY',
  }
  return map[value] || null
}

module.exports = {
  mapCompanyActivation,
  mapUserStatus,
  mapEmailVerified,
  mapRoleScope,
}
