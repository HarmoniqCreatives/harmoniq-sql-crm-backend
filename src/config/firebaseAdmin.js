'use strict'

/**
 * Firebase Admin SDK bootstrap for FCM (Android / iOS / Web).
 *
 * Credentials (never commit real values):
 * - FIREBASE_SERVICE_ACCOUNT_PATH — absolute/relative path to service-account JSON
 * - FIREBASE_SERVICE_ACCOUNT_JSON — raw JSON string (preferred in secret managers)
 *
 * Lazy-initializes once. Returns null when credentials are absent so push stays optional.
 */

let messagingInstance = null
let initAttempted = false
let initError = null

function parseServiceAccount() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()
  if (rawJson) {
    return JSON.parse(rawJson)
  }
  const pathValue = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim()
  if (pathValue) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const fs = require('fs')
    const path = require('path')
    const resolved = path.isAbsolute(pathValue)
      ? pathValue
      : path.resolve(process.cwd(), pathValue)
    const contents = fs.readFileSync(resolved, 'utf8')
    return JSON.parse(contents)
  }
  return null
}

/**
 * @returns {import('firebase-admin/messaging').Messaging | null}
 */
function getFirebaseMessaging() {
  if (initAttempted) {
    return messagingInstance
  }
  initAttempted = true
  try {
    const serviceAccount = parseServiceAccount()
    if (!serviceAccount) {
      return null
    }
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin')
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      })
    }
    messagingInstance = admin.messaging()
    return messagingInstance
  } catch (error) {
    initError = error
    messagingInstance = null
    console.error('[firebase-admin] init failed:', error.message)
    return null
  }
}

function isFirebaseAdminConfigured() {
  return Boolean(getFirebaseMessaging())
}

function getFirebaseAdminInitError() {
  return initError
}

/** Test helper — resets lazy init state. */
function resetFirebaseAdminForTests() {
  messagingInstance = null
  initAttempted = false
  initError = null
}

module.exports = {
  getFirebaseMessaging,
  isFirebaseAdminConfigured,
  getFirebaseAdminInitError,
  resetFirebaseAdminForTests,
}
