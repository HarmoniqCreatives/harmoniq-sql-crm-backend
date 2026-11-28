# FILOS CRM — Global Super Admin Permission Policy

**Status:** Permanent architecture / security standard  
**Applies to:** Every current and future module (backend APIs, frontend screens, menus, buttons)

## Core rule

Protected **Super Admin** automatically has access to **all** feature permissions — including permissions that do not exist yet in the catalog. New features must never require manual Super Admin role–permission mapping or seeding.

Super Admin bypasses **feature permissions only**. It does **not** bypass:

- Authentication (`requireAuth`, valid session, verified email)
- Account / company status (active user, active company)
- Multi-tenant isolation (`companyId` from auth context only)
- Privilege-escalation rules when assigning permissions to *other* roles (unknown keys still cannot be written into role JSON)

## How Super Admin is identified (server-trusted)

Backend and frontend both treat a role as Super Admin when either is true (from DB-backed `/api/auth/me` / `req.auth.role`, never from client-invented claims):

- `role.isProtected === true`, or
- `role.key === 'super_admin'`

## Central helpers (required for all new work)

| Layer | Use this | Do not |
| --- | --- | --- |
| Backend routes | `requirePermission(key)` / `requireAnyPermission([...])` from `middleware/auth.js` | Inline `role.permissions.includes` |
| Backend services | `hasPermission(auth, key)` from `services/accessService.js` | Per-feature Super Admin `if` chains (unless a non-permission rule) |
| Frontend UX | `hasPermission(user, key)` / `perm.*` from `auth/permissions.js` | Hardcoded Super Admin checks on each button/page |

`requirePermission` delegates to `hasPermission`, so middleware and services share one policy.

## Roles that are not Super Admin

Admin, Manager, Agent, and custom roles use **explicitly assigned** permission keys only. Never auto-grant the full catalog to non–Super Admin roles.

## Granting permissions to others

`assertCanAssignPermissions` still requires keys to be **known** in the permission registry. Super Admin may grant any *catalog* key to another role, but cannot invent unknown keys into stored role permissions. Feature *access* for Super Admin itself does not depend on catalog membership.

## Instructions for future developers

1. Add new permission keys to the backend registry / enums / seed for Admin and lower roles as needed.
2. Protect every new API with `requireAuth` + `requirePermission('module.action')` (or service-level `hasPermission`).
3. Gate every new frontend menu, page, and action with `hasPermission(user, perm.…)`.
4. Do **not** add Super Admin to the seed permission list as a prerequisite for access — the bypass is automatic.
5. Do **not** weaken tenant checks or skip `requireAuth` for Super Admin.
6. Add or extend tests that Super Admin passes a key absent from the catalog, and that Admin without the key gets 403.

## Related code

- `backend/src/services/accessService.js` — `isProtectedGrantor`, `hasPermission`
- `backend/src/middleware/auth.js` — `requireAuth`, `requirePermission`, `requireAnyPermission`
- `frontend/src/auth/permissions.js` — client `hasPermission` / `isSuperAdmin`
- Tests: `backend/test/accessPermissions.test.js`, `backend/test/requirePermission.middleware.test.js`, `frontend/src/auth/permissions.test.js`
