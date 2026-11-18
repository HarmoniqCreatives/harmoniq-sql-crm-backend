# Dry-run: sampleExport.json

Generated: 2026-11-17T12:50:08.839Z
Result: PASS

## Counts
- Companies: 2
- Roles: 4
- Users: 4

### Roles per company
- aaaaaaaaaaaaaaaaaaaaaaaa: 3
- bbbbbbbbbbbbbbbbbbbbbbbb: 1

### Users per company
- aaaaaaaaaaaaaaaaaaaaaaaa: 3
- bbbbbbbbbbbbbbbbbbbbbbbb: 1

## Password compatibility gate
- Passed: false
- Tested at: n/a

## Errors (0)
- None

## Warnings (4)
- [company_marked_inactive] Company hint isActive=false → PENDING_VERIFICATION unless forceStatus set
- [email_verified_coerced_true] emailVerified unset → true for active staff (BD-2)
- [active_user_unverified] ACTIVE user has emailVerified=false (will not login until verified)
- [password_gate_not_passed] Password compatibility gate not passed — import must not copy hashes until staging test succeeds

## Redacted error details (JSON)
```json
[]
```

## Transform preview (redacted)
```json
{
  "companies": 2,
  "roles": 4,
  "users": 4,
  "sampleCompany": {
    "id": "87329da4-ceb1-46f2-b522-d7bf16ac11fc",
    "mongoId": "aaaaaaaaaaaaaaaaaaaaaaaa",
    "name": "Falcon Premier",
    "nameKey": "falcon premier",
    "timezone": "Asia/Dubai",
    "baseCurrency": "AED",
    "enabledCurrencies": [
      "AED",
      "INR",
      "PKR"
    ],
    "logoUrl": null,
    "isActive": true,
    "status": "ACTIVE",
    "metaDefaultAssigneeUserId": null,
    "emailReportsEnabled": false,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  },
  "sampleRole": {
    "id": "28b7a705-438a-47e0-84da-edb628b7a2a7",
    "mongoId": "role11111111111111111111",
    "companyId": "87329da4-ceb1-46f2-b522-d7bf16ac11fc",
    "companyMongoId": "aaaaaaaaaaaaaaaaaaaaaaaa",
    "key": "super_admin",
    "name": "Super Admin",
    "description": "Full system administration",
    "permissions": [
      "users.view",
      "users.create",
      "users.edit",
      "users.delete",
      "users.invite",
      "roles.view",
      "roles.create",
      "roles.edit",
      "roles.delete",
      "permissions.manage",
      "leads.view",
      "leads.create",
      "leads.edit",
      "leads.delete",
      "leads.assign",
      "reports.view",
      "settings.manage",
      "leads.bulk",
      "activities.manage",
      "templates.manage",
      "communications.send",
      "meta.view",
      "meta.manage",
      "meta.pages.manage",
      "whatsapp.manage",
      "whatsapp.view_logs",
      "audit.view",
      "users.manage",
      "roles.manage"
    ],
    "scope": "COMPANY",
    "isSystem": true,
    "isProtected": true,
    "permissionMeta": {
      "omitted": [],
      "expandedFrom": [
        "super_admin_full_sql_set"
      ]
    },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  },
  "sampleUser": {
    "id": "f89263b1-991e-44d3-8e03-1d6e7b60596f",
    "mongoId": "user11111111111111111111",
    "companyId": "87329da4-ceb1-46f2-b522-d7bf16ac11fc",
    "companyMongoId": "aaaaaaaaaaaaaaaaaaaaaaaa",
    "roleId": "28b7a705-438a-47e0-84da-edb628b7a2a7",
    "roleMongoId": "role11111111111111111111",
    "branchId": null,
    "teamId": null,
    "name": "Owner One",
    "email": "owner@falcon.example",
    "phone": "+971500000001",
    "passwordHash": "[REDACTED]",
    "status": "ACTIVE",
    "emailVerified": true,
    "isInitialSuperAdmin": true,
    "isPlatformOperator": false,
    "emailVerifyTokenHash": null,
    "emailVerifyExpiresAt": null,
    "resetTokenHash": null,
    "resetExpiresAt": null,
    "lastLoginAt": "2024-12-01T00:00:00.000Z",
    "disabledAt": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  },
  "superAdminPermissionsCount": 29
}
```
