# Cross-platform push notifications (Phase J / J2)

Backend is the single source of truth: **one `notifications` row per event**, then fan-out to:

- Web in-app (SSE + optional browser FCM)
- Mobile FCM (Android / iOS)
- Delivery rows in `notification_deliveries` (one per active device)

## Schema (existing migration)

- `notifications` — company + user scoped, idempotency unique `(companyId, idempotencyKey)`
- `user_device_tokens` — stores FCM/Expo token in `expoPushToken`, platforms: `android` | `ios` | `web`
- `notification_deliveries` — per-device send attempts

Migration file: `backend/src/migrations/20261124120000-notification-foundation.js`  
Run locally only: `cd backend && npm run db:migrate` (never against production from this task).

## Backend environment

| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Path to Firebase Admin service-account JSON |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Inline JSON (secret managers) |
| `FIREBASE_SERVER_KEY` | Legacy HTTP FCM fallback only if Admin unset |
| `NOTIFICATION_PUSH_ENABLED` | `1` / `0` |
| `NOTIFICATION_PUSH_INTERVAL_MS` | Worker poll interval |
| `NOTIFICATION_PUSH_LEASE_MS` | Delivery claim lease (min 10000; default 60000) |
| `NOTIFICATION_PUSH_PROVIDER_TIMEOUT_MS` | Provider wait (1000–55000; always clamped strictly below lease − 2s margin) |
| `NOTIFICATION_PUSH_RECONCILE_LOOKBACK_HOURS` | Missing-pair reconcile lookback (default 24) |
| `NOTIFICATION_PUSH_RECONCILE_BATCH` | Max missing pairs per reconcile tick (default 50) |

Never commit service-account JSON or server keys.

## Reliability notes

- **Transactional create:** When `createNotification` runs inside a Sequelize transaction, push delivery rows are inserted in that same transaction. Rollback removes both. SSE emits only after commit (with a persisted-row check because Sequelize 6.37.8 may invoke `afterCommit` hooks even if `COMMIT` fails).
- **Reconcile:** Worker backfills missing `(notificationId, deviceTokenId)` pairs for active tokens whose `createdAt <= notification.createdAt` (excludes late-registered devices). Existing delivery rows of any status are never recreated.
- **FCM Admin timeout:** `firebase-admin` `messaging.send()` has no AbortSignal. The worker uses `Promise.race` to bound wait time; the underlying HTTP request is not cancelled. Duplicate send remains possible if the SDK succeeds after timeout/lease reclaim (at-least-once). Stale workers cannot finalize after `lockToken` reclaim.

## Firebase Console (manual)

1. Create / select a Firebase project.
2. Add Android app with package `com.filoscrm.app` → download `google-services.json`.
3. Add iOS app with bundle id `com.filoscrm.app` → download `GoogleService-Info.plist`.
4. Add Web app → copy config into frontend `VITE_FIREBASE_*`.
5. Project settings → **Service accounts** → Generate new private key → store privately; set `FIREBASE_SERVICE_ACCOUNT_PATH` on the API host.
6. Cloud Messaging → **Web Push certificates** → generate key pair → `VITE_FIREBASE_VAPID_KEY`.
7. **Apple**: Apple Developer → Keys → Apple Push Notifications service (APNs) → upload `.p8` in Firebase → Project settings → Cloud Messaging → Apple app configuration. Enable Push Notifications capability in Xcode. **iOS push is not verified until this is done on a physical device.**

## Android (`melo-mobile-cli`)

1. Copy `android/app/google-services.json.example` → `android/app/google-services.json` and replace placeholders with the Firebase download.
2. Google Services Gradle plugin applies only when that file exists.
3. Rebuild: `npm run android` (or `android:assemble` when Gradle deps are available).
4. Grant notification permission when prompted (Android 13+).
5. Sign in as an agent; transfer a lead from Web → confirm system notification and tap opens Lead.

## iOS (`melo-mobile-cli`)

1. Copy `ios/GoogleService-Info.plist.example` → `ios/GoogleService-Info.plist` (or under `ios/MeloCrm/`) from Firebase.
2. `cd ios && pod install`
3. Xcode: enable **Push Notifications** + **Background Modes → Remote notifications**.
4. Upload APNs auth key to Firebase (see above).
5. Test on a **physical device** only (simulator does not receive remote push reliably).

Until APNs + device testing succeed, treat iOS push as **prepared, not operational**.

## Web CRM (`frontend`)

1. Copy `frontend/.env.example` → `.env.local` and fill `VITE_FIREBASE_*` + VAPID.
2. `npm run dev` / `npm run build` regenerates `public/firebase-messaging-sw.js` via Vite plugin.
3. Sign in → open notification bell → **Enable alerts** (user gesture required).
4. Supported: Chrome and Edge. Safari/Firefox have limited or no FCM web support depending on OS — in-app bell + SSE still work without browser push.

## Device APIs (unchanged paths)

- `POST /api/notifications/devices` `{ token, platform: android|ios|web, deviceId?, appVersion? }`
- `POST /api/notifications/devices/deactivate` `{ token? }` (empty body = all devices for user)

Logout deactivates the current device token (Web + Mobile).

## Browser limitations

- Browser push requires HTTPS (or localhost).
- Permission must be requested from a user gesture.
- Safari on iOS does not use this FCM web path; use the native iOS app instead.

## Security

- Recipient user IDs are never taken from clients for event creation.
- List/read/unread/device endpoints use `requireAuth` and filter by `auth.companyId` + `auth.userId`.
- Do not log FCM tokens or service-account material.
