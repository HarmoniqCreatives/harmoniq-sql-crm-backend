/**
 * Central permission registry.
 *
 * Future modules should call `registerPermission({ key, module, description })`
 * (or append here) so roles UI and escalation checks stay consistent.
 */

const permissionRegistry = [
  { key: 'users.view', module: 'users', description: 'View the company user directory' },
  { key: 'users.create', module: 'users', description: 'Create users directly' },
  { key: 'users.edit', module: 'users', description: 'Edit users, status, branch and team' },
  { key: 'users.delete', module: 'users', description: 'Deactivate or remove non-protected users' },
  { key: 'users.invite', module: 'users', description: 'Invite users by email' },
  { key: 'roles.view', module: 'roles', description: 'View roles and permissions' },
  { key: 'roles.create', module: 'roles', description: 'Create custom roles' },
  { key: 'roles.edit', module: 'roles', description: 'Edit custom role permissions and details' },
  { key: 'roles.delete', module: 'roles', description: 'Delete custom roles' },
  { key: 'permissions.manage', module: 'roles', description: 'Manage advanced permission assignments' },
  { key: 'leads.view', module: 'leads', description: 'View leads' },
  { key: 'leads.create', module: 'leads', description: 'Create leads' },
  { key: 'leads.edit', module: 'leads', description: 'Edit leads' },
  { key: 'leads.delete', module: 'leads', description: 'Delete leads' },
  { key: 'leads.assign', module: 'leads', description: 'Assign leads' },
  { key: 'leads.bulk', module: 'leads', description: 'Bulk lead actions and CSV export' },
  { key: 'reports.view', module: 'reports', description: 'View reports' },
  { key: 'settings.manage', module: 'settings', description: 'Manage company settings and catalogs' },
  { key: 'meta.view', module: 'meta', description: 'View Meta connections and Pages' },
  { key: 'meta.manage', module: 'meta', description: 'Manage Meta app profiles and Facebook OAuth' },
  { key: 'meta.pages.manage', module: 'meta', description: 'Connect and disconnect Facebook Pages' },
]

/**
 * Registers or updates a permission entry for a feature module.
 *
 * @param {{ key: string, module: string, description?: string }} entry
 * @returns {{ key: string, module: string, description: string }}
 */
function registerPermission(entry) {
  if (!entry || !entry.key || !entry.module) {
    throw new Error('Permission entries require key and module.')
  }
  const existing = permissionRegistry.find((row) => row.key === entry.key)
  if (existing) {
    existing.module = entry.module
    existing.description = entry.description || existing.description
    return existing
  }
  const created = {
    key: entry.key,
    module: entry.module,
    description: entry.description || '',
  }
  permissionRegistry.push(created)
  return created
}

function listPermissions() {
  return permissionRegistry.slice().sort((a, b) => {
    if (a.module === b.module) {
      return a.key.localeCompare(b.key)
    }
    return a.module.localeCompare(b.module)
  })
}

function isKnownPermission(key) {
  return permissionRegistry.some((row) => row.key === key)
}

function permissionKeysFromRegistry() {
  const keys = {}
  for (const row of permissionRegistry) {
    const camel = row.key.replace(/\.([a-z])/g, (_, letter) => letter.toUpperCase())
    keys[camel] = row.key
  }
  return keys
}

module.exports = {
  permissionRegistry,
  registerPermission,
  listPermissions,
  isKnownPermission,
  permissionKeysFromRegistry,
}
