# Tenant data migration utility (Companies / Branches / Teams / Roles / Users)

Safe MongoDB → Harmoniq SQL migration tools for **tenant login readiness** and org structure.

## Scope

| In | Out |
|----|-----|
| Companies (+ settings needed for login) | Leads and lead children |
| Branches | Invitations, Catalog, Counters |
| Teams (manager resolved after users) | Meta, WhatsApp, Email reports |
| Roles + permissions | Sessions / operational logs |
| Users (auth + branch/team FKs) | |

Password hashes are copied **only** after the password compatibility gate passes.

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
  index.js
  dryRun.js
  runDryRun.js
  export/exportMongo.js
  import/importSql.js
  lib/{idMap,permissionMap,statusMap,passwordGate,validators,sanitize,report,reconcile}.js
  fixtures/sampleExport.json
  reports/
```

## Safety gates

- **No automatic DB connections.** Live Mongo export requires `allowLiveExport: true` **and** `MIGRATION_ALLOW_LIVE_MONGO=1`.
- Live SQL import requires `allowLiveImport: true`, `MIGRATION_ALLOW_LIVE_SQL_IMPORT=1`, `MIGRATION_IMPORT_APPROVED=1`, and **password gate passed**.
- Import uses `findOrCreate` by primary key — **never overwrites** existing production rows.
- Destination conflicts (e.g. same email different id) abort unless `allowConflicts: true`.
- Logs and reports **redact** `passwordHash` and other secrets.
- Automated tests use **synthetic fixtures** and an **in-memory isolated store** (never `harmoniq_creative_crm`).

## Commands

### Automated tests (synthetic / isolated)

```bash
cd backend
node --test --test-concurrency=1 test/userMigration.test.js
```

### Dry-run against fixture / offline JSON

```bash
cd backend
node src/migration/runDryRun.js src/migration/fixtures/sampleExport.json
```

### Offline Compass backup export (11 active users)

Writes an **unredacted** export outside the repo (`~/.local/share/harmoniq-migration/`, mode `600`). Does not connect to Mongo/SQL.

```bash
cd backend
node src/migration/runCompassBackupExport.js
```

### Production VPS read-only dry-run (SELECT only)

Runs on the VPS against `harmoniq_creative_crm_live`. Never enables import flags and never calls `importToSqlLive`.

```bash
# From laptop — sync migration package only (no .env)
rsync -avz -e "ssh -i ~/Documents/Project/sshKey/harmoniq_vps_ed25519 -o IdentitiesOnly=yes" \
  --exclude node_modules --exclude .env --exclude reports \
  ~/Documents/Project/Harmoniq-creative-crm/backend/src/migration/ \
  deploy@189.72.157.166:/home/deploy/apps/melo/backend/src/migration/

# On VPS
ssh -i ~/Documents/Project/sshKey/harmoniq_vps_ed25519 -o IdentitiesOnly=yes deploy@189.72.157.166
cd /home/deploy/apps/melo/backend
BACKEND_ROOT=/home/deploy/apps/melo/backend \
EXPORT_PATH=/home/deploy/migration-staging/production-11-user-export.json \
REPORT_DIR=/home/deploy/migration-staging/reports \
REQUIRED_DB_NAME=harmoniq_creative_crm_live \
node src/migration/runProductionReadOnlyDryRun.js
```

Pre-existing backup (do not overwrite):  
`/home/deploy/backups/harmoniq_creative_crm_live-2026-11-19T03-05-03-439Z.sql`

### Live import (separate explicit approval only)

Requires env flags for the process only; do not leave them in `.env`. Take a SQL backup first. Dry-run must be PASS with **zero conflicts**.

```bash
cd /home/deploy/apps/melo/backend
MIGRATION_ALLOW_LIVE_SQL_IMPORT=1 MIGRATION_IMPORT_APPROVED=1 \
BACKEND_ROOT=/home/deploy/apps/melo/backend \
EXPORT_PATH=/home/deploy/migration-staging/production-11-user-export.json \
REPORT_DIR=/home/deploy/migration-staging/reports \
REQUIRED_DB_NAME=harmoniq_creative_crm_live \
node src/migration/runProductionImport.js
```

Import uses destination remapping + `findOrCreate` (no overwrite). Conflicts abort the run.

## Import order (transaction)

1. Companies  
2. Roles  
3. Branches  
4. Teams (`managerUserId` null initially)  
5. Users (with `branchId` / `teamId` when valid)  
6. Team manager second pass (set only when currently null)

## Related

See repository root: `STEP-2-USER-MIGRATION-FINAL.md` (historical phase-2 notes; branches/teams now in scope).
