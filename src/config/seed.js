const {
  catalogKinds,
  catalogTones,
  currencies,
  permissionKeys,
  roleKeys,
  roleScopes,
} = require('../utils/enums')

const adminUserPermissions = [
  permissionKeys.usersView,
  permissionKeys.usersCreate,
  permissionKeys.usersEdit,
  permissionKeys.usersDelete,
  permissionKeys.usersInvite,
  permissionKeys.rolesView,
  permissionKeys.rolesCreate,
  permissionKeys.rolesEdit,
  permissionKeys.rolesDelete,
  permissionKeys.permissionsManage,
  permissionKeys.leadsView,
  permissionKeys.leadsCreate,
  permissionKeys.leadsEdit,
  permissionKeys.leadsDelete,
  permissionKeys.leadsAssign,
  permissionKeys.leadsBulk,
  permissionKeys.reportsView,
  permissionKeys.settingsManage,
  permissionKeys.metaView,
  permissionKeys.metaManage,
  permissionKeys.metaPagesManage,
]

const roleSeeds = [
  {
    key: roleKeys.superAdmin,
    name: 'Super Admin',
    description: 'Full company administration',
    permissions: Object.values(permissionKeys),
    scope: roleScopes.company,
    isSystem: true,
    isProtected: true,
  },
  {
    key: roleKeys.admin,
    name: 'Admin',
    description: 'Manage users, roles, leads, settings and integrations',
    permissions: adminUserPermissions,
    scope: roleScopes.company,
    isSystem: true,
    isProtected: false,
  },
  {
    key: roleKeys.manager,
    name: 'Manager',
    description: 'Manage team leads and activities',
    permissions: [
      permissionKeys.leadsView,
      permissionKeys.leadsEdit,
      permissionKeys.leadsAssign,
      permissionKeys.usersView,
      permissionKeys.reportsView,
    ],
    scope: roleScopes.team,
    isSystem: true,
    isProtected: false,
  },
  {
    key: roleKeys.agent,
    name: 'Agent',
    description: 'Work on assigned leads and follow-ups',
    permissions: [
      permissionKeys.leadsView,
      permissionKeys.leadsEdit,
    ],
    scope: roleScopes.own,
    isSystem: true,
    isProtected: false,
  },
]

/** Default catalogs mirror legacy faloniq seed.js (11 statuses, 4 tags incl. Angry, 4 activities). */
const catalogSeeds = [
  { kind: catalogKinds.status, key: 'new', name: 'New', sortOrder: 1, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'assigned', name: 'Assigned', sortOrder: 2, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'contacted', name: 'Contacted', sortOrder: 3, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'callback', name: 'Callback', sortOrder: 4, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'meeting_scheduled', name: 'Meeting Scheduled', sortOrder: 5, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'site_visit_scheduled', name: 'Site Visit Scheduled', sortOrder: 6, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'interested', name: 'Interested', sortOrder: 7, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'negotiation', name: 'Negotiation', sortOrder: 8, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'won', name: 'Won', sortOrder: 9, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'lost', name: 'Lost', sortOrder: 10, tone: catalogTones.none },
  { kind: catalogKinds.status, key: 'cancelled', name: 'Cancelled', sortOrder: 11, tone: catalogTones.none },
  { kind: catalogKinds.tag, key: 'interested', name: 'Interested', sortOrder: 1, tone: catalogTones.green },
  { kind: catalogKinds.tag, key: 'not_interested', name: 'Not Interested', sortOrder: 2, tone: catalogTones.red },
  { kind: catalogKinds.tag, key: 'warm', name: 'Warm', sortOrder: 3, tone: catalogTones.amber },
  { kind: catalogKinds.tag, key: 'angry', name: 'Angry', sortOrder: 4, tone: catalogTones.red },
  { kind: catalogKinds.activity, key: 'callback', name: 'Callback', sortOrder: 1, tone: catalogTones.none },
  { kind: catalogKinds.activity, key: 'meeting', name: 'Meeting', sortOrder: 2, tone: catalogTones.none },
  { kind: catalogKinds.activity, key: 'site_visit', name: 'Site Visit', sortOrder: 3, tone: catalogTones.none },
  { kind: catalogKinds.activity, key: 'follow_up_call', name: 'Follow-up Call', sortOrder: 4, tone: catalogTones.none },
]

const companyDefaults = {
  timezone: 'Asia/Kolkata',
  baseCurrency: currencies.inr,
  enabledCurrencies: [currencies.inr, currencies.aed, currencies.usd, currencies.eur],
}

module.exports = { roleSeeds, catalogSeeds, companyDefaults, adminUserPermissions }
