# Lead Excel Import (Backend)

Platform-neutral REST APIs for Excel bulk lead import. Web CRM consumes these first; Melo Mobile can reuse the same endpoints later.

## Permission

- `leads.import` — required for all `/api/leads/import/*` routes
- Also required for actions inside confirm:
  - Create rows → `leads.create`
  - Update Existing → `leads.edit`
  - Assign agent during create/update → `leads.assign` when assigning another user

Seeded for Super Admin (all keys) and Admin. Not granted to Manager/Agent by default.

## Limits

- File type: `.xlsx` only (validated by extension + ZIP signature + ExcelJS load)
- Max size: 10 MB
- Max data rows: 5,000
- Formulas are not executed; cell values/results only

## Session lifecycle

1. `GET /api/leads/import/template` — download workbook template
2. `POST /api/leads/import/sessions` — multipart `file` plus optional `sheetIndex` / `headerRow` → status `uploaded` (returns sheets meta, suggested mapping, confidence, header fingerprint)
3. `POST /api/leads/import/sessions/:id/validate` — body `{ mapping, valueMappings? }` → status `validated`
4. Client maps unknown catalog/enum values (Status / Source / Agent / Tags), re-validates, then resolves duplicates
5. `POST /api/leads/import/sessions/:id/confirm` — body `{ decisions, confirmToken? }` → status `completed` (idempotent)
6. `GET /api/leads/import/sessions/:id` — status/results
7. `GET /api/leads/import/sessions/:id/errors.xlsx` — error report (validation + need_review + duplicates)

`companyId` always comes from auth. Sessions are company + initiator scoped. No new import tables/columns for value maps — `valueMappings` and raw `sourceRows` live in session JSON.

## Universal import engine (approved)

- Sheet/header selection is generic (no per-file hardcoding).
- Field mapping: synonym/exact confidence only; unmatched headers stay Skip.
- Value mapping (G1 sources): map Excel strings onto existing company Status/Tag/Agent catalogs or the four platform sources (`manual|facebook|instagram|website`). Unknown values such as `Direct` / `QRCode` become **Need Review** until the user maps them explicitly. Exact catalog matches resolve automatically; no auto-create; no status/source equivalence guessing.
- Mapping memory: **client-only** `localStorage` keyed by `companyId + headerFingerprint`. Server always reloads current company catalogs on validate.
- Invalid = genuine rule failures (name/phone/email/dates/etc.). Need Review = unresolved catalogs and/or duplicate phone decisions.

## Duplicate decisions

For CRM phone matches:

| Action | Body |
|--------|------|
| Skip | `{ excelRowNumber, action: "skip" }` |
| Update Existing | `{ excelRowNumber, action: "update_existing", existingLeadId }` |
| Import as New | `{ excelRowNumber, action: "import_as_new", confirmImportAsNew: true }` |

Update Existing: blank Excel cells never overwrite; notes append; tags merge.

## Provenance fields

- `entryMethod` (Added Via): `manual` \| `excel_import` \| `meta_import` \| `api_import` \| `unknown`
- `importSessionId` (Import Batch ID): set for Excel-created leads only
- `importedAt`: set for Meta/Excel at create time; null for manual/unknown; immutable after create
- Manual create → `manual`; Meta path → `meta_import`; Excel confirm → `excel_import`
- API/UI may expose aliases `addedVia` / `importBatchId` — same stored columns (no duplicates)
- Client cannot set or change origin fields; Update Existing / assign / transfer preserve them

## Notes

Each Lead note N (Notes 1–10) becomes a separate `lead_notes` history row. Empty note cells are skipped. Matched authors use `createdBy`; unmatched authors set `createdBy` to the importer and store the Excel name in `authorDisplayName`.

## Phone normalization (Excel validate)

Valid E.164 numbers (`+…`) are preserved. Local/national numbers may be normalized using the existing company dial context (timezone → dial, else baseCurrency → dial: Asia/Kolkata/+91, Asia/Dubai/+971, Asia/Karachi/+92, INR/AED/PKR). If dial context is unavailable or the number is ambiguous/invalid, the row stays Invalid with an explicit reason. No new company schema field.

## Notifications

Bulk Excel confirm suppresses per-row assignment email/WhatsApp/push. Response includes `assignmentSummary` for a consolidated digest.

## Web CRM UI

Leads page **Import Excel** (gated by `leads.import`, with permanent Super Admin bypass via `hasPermission` / `canShowImportExcel`) opens a wizard: template download → upload → sheet/header + column mapping → value mapping → preview/Manual Review → confirm → results + error report download.

Primary UI: `frontend/src/pages/leads/ImportLeadsDialog.jsx`.

## Production migration (do not run from this workspace)

Apply once on production when releasing this feature:

- `backend/src/migrations/20261125120000-lead-excel-import.js`

Safe for existing rows: new lead columns are nullable or default (`entryMethod='manual'`); `authorDisplayName` is nullable; new `lead_import_sessions` table is empty. Also re-seed roles/permissions so Admin receives `leads.import`. Never point `DB_NAME_TEST` at production.

## Future mobile

Same JSON + multipart APIs. No mobile-specific routes.
