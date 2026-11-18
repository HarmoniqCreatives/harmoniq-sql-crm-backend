# User-phase migration utility (Companies / Roles / Users)

Safe MongoDB → Harmoniq SQL migration tools for **tenant login readiness only**.

## Scope

| In | Out |
|----|-----|
| Companies | Leads, Branches, Teams |
| Roles + permissions | Invitations, Catalog, Counters |
| Users (auth fields) | Meta, WhatsApp, Email reports, Sessions |

`users.branchId` and `users.teamId` are always set to `NULL`.

## Approved business decisions (BD-1 … BD-6)

| ID | Decision |
|----|----------|
| BD-1 | Live companies → `ACTIVE` + `isActive=true`; inactive hints → pending |
| BD-2 | `emailVerified === false` stays false; unset + active staff → `true` |
| BD-3 | Disabled users → `DISABLED` |
| BD-4 | Super Admin / `isProtected` → full SQL permission key set |
| BD-5 | Password hashes copied **only after** staging bcrypt compatibility test passes |
| BD-6 | Multiple `isInitialSuperAdmin` per company → **error** (manual review) |

## Layout

```
src/migration/
  README.md
  index.js                 # public API
  dryRun.js
  runDryRun.js             # CLI dry-run (JSON file only)
  export/exportMongo.js    # fixture export + gated live Mongo
  import/importSql.js      # plan builder + gated live SQL
  lib/idMap.js
  lib/permissionMap.js
  lib/statusMap.js
  lib/passwordGate.js
  lib/validators.js
  lib/sanitize.js
  lib/report.js
  fixtures/sampleExport.json
  reports/sample-validation-report.md
```

## Safety gates

- **No automatic DB connections.** Live Mongo export requires `allowLiveExport: true` **and** `MIGRATION_ALLOW_LIVE_MONGO=1`.
- Live SQL import requires `allowLiveImport: true`, `MIGRATION_ALLOW_LIVE_SQL_IMPORT=1`, `MIGRATION_IMPORT_APPROVED=1`, and **password gate passed**.
- Logs and reports **redact** `passwordHash` and other secrets.
- Automated tests use **synthetic fixtures only**.

## Commands

### Automated tests (synthetic)

```bash
cd /home/avinash/Documents/Project/Harmoniq-creative-crm/backend
npm test -- --test-name-pattern=userMigration
# or full suite:
npm test
```

### Dry-run against fixture / offline JSON

```bash
cd /home/avinash/Documents/Project/Harmoniq-creative-crm/backend
node src/migration/runDryRun.js src/migration/fixtures/sampleExport.json
```

### Staging password compatibility probe (manual)

Use a **dedicated staging test account** only. Do not print the hash.

```js
const bcrypt = require('bcrypt')
const { runPasswordCompatibilityTest } = require('./src/migration')
// passwordHash loaded privately from staging export — never console.log it
await runPasswordCompatibilityTest({ password: process.env.STAGING_TEST_PASSWORD, passwordHash })
```

If the probe fails: **do not copy hashes**. Fix compatibility or use password-reset onboarding.

### Future staging dry-run (offline export file)

1. On a **non-production** Mongo replica/staging, produce a JSON export offline (operator-controlled).
2. Set `passwordGate.passed=true` only after BD-5 probe succeeds.
3. `node src/migration/runDryRun.js /path/to/staging-export.json`
4. Fix all **errors**; review **warnings**.
5. Real SQL import requires a **separate explicit approval** and env flags above — not enabled by default.

## Permission rules

- Preserve Mongo permission arrays (no seed replacement).
- Expand `users.manage` → `users.view|create|edit|delete|invite` (+ keep `users.manage`).
- Expand `roles.manage` → `roles.view|create|edit|delete` + `permissions.manage` (+ keep `roles.manage`).
- `meta.manage` also adds `meta.view`.
- Super Admin receives every SQL `permissionKeys` value (Harmoniq middleware has no `isProtected` bypass).

## Related spec

See repository root: `STEP-2-USER-MIGRATION-FINAL.md`.
