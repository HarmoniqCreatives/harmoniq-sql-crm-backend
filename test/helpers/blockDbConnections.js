'use strict'

/**
 * Preload for `npm run test:unit` (`node --require …`).
 *
 * Runs BEFORE any test file. Blocks MySQL at multiple layers:
 * 1. HC_UNIT_TEST_BLOCK_DB=1 (also enforced in src/config/database.js)
 * 2. mysql2 / mysql2/promise createConnection, createPool, clusters, Connection
 * 3. Sequelize MySQL dialect connection manager + authenticate/query
 *
 * Never opens a real socket.
 */

process.env.HC_UNIT_TEST_BLOCK_DB = '1'
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

const BLOCK_MSG = '[test-isolation] MySQL access is blocked during unit tests (HC_UNIT_TEST_BLOCK_DB=1).'

function blockedError() {
  return new Error(BLOCK_MSG)
}

function throwBlocked() {
  throw blockedError()
}

async function throwBlockedAsync() {
  throw blockedError()
}

function shouldBlock() {
  return String(process.env.HC_UNIT_TEST_BLOCK_DB || '') === '1'
}

function wrapAsync(original) {
  return async function blockedAsyncWrapper(...args) {
    if (shouldBlock()) throwBlocked()
    return original.apply(this, args)
  }
}

/**
 * Replace a function export even when the property is getter-only.
 * @param {object} target
 * @param {string} key
 * @param {Function} replacement
 * @returns {boolean}
 */
function forceReplaceFunction(target, key, replacement) {
  if (!target || typeof target[key] !== 'function') return false
  try {
    target[key] = replacement
    return typeof target[key] === 'function'
  } catch (_assignError) {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: replacement,
      })
      return true
    } catch (_defineError) {
      return false
    }
  }
}

/**
 * Patch every known mysql2 connection/pool entry point.
 * Safe to call multiple times.
 */
function blockMysqlDrivers() {
  const specs = [
    {
      id: 'mysql2',
      methods: {
        createConnection: throwBlocked,
        createPool: throwBlocked,
        createPoolCluster: throwBlocked,
        connect: throwBlocked,
        createConnectionPromise: throwBlockedAsync,
        createPoolPromise: throwBlockedAsync,
        createPoolClusterPromise: throwBlockedAsync,
      },
    },
    {
      id: 'mysql2/promise',
      methods: {
        createConnection: throwBlockedAsync,
        createPool: throwBlockedAsync,
        createPoolCluster: throwBlockedAsync,
      },
    },
  ]

  for (const spec of specs) {
    let mod
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      mod = require(spec.id)
    } catch (_error) {
      continue
    }
    if (!mod || typeof mod !== 'object') continue

    for (const [method, replacement] of Object.entries(spec.methods)) {
      forceReplaceFunction(mod, method, replacement)
    }

    if (typeof mod.Connection === 'function' && !mod.Connection.__hcUnitBlocked) {
      const OriginalConnection = mod.Connection
      function BlockedConnection(...args) {
        if (shouldBlock()) throwBlocked()
        return new OriginalConnection(...args)
      }
      BlockedConnection.prototype = OriginalConnection.prototype
      Object.setPrototypeOf(BlockedConnection, OriginalConnection)
      BlockedConnection.__hcUnitBlocked = true
      forceReplaceFunction(mod, 'Connection', BlockedConnection)
    }

    if (mod.promise && typeof mod.promise === 'object') {
      forceReplaceFunction(mod.promise, 'createConnection', throwBlockedAsync)
      forceReplaceFunction(mod.promise, 'createPool', throwBlockedAsync)
      forceReplaceFunction(mod.promise, 'createPoolCluster', throwBlockedAsync)
    }
  }
}

/**
 * Block Sequelize MySQL usage even when tests construct Sequelize directly
 * (bypassing getSequelize).
 */
function blockSequelizeMysql() {
  let Sequelize
  try {
    // eslint-disable-next-line global-require
    Sequelize = require('sequelize')
  } catch (_error) {
    return
  }
  const SequelizeClass = Sequelize.Sequelize || Sequelize
  if (!SequelizeClass || !SequelizeClass.prototype) return

  if (!SequelizeClass.prototype.authenticate.__hcUnitBlocked) {
    const originalAuthenticate = SequelizeClass.prototype.authenticate
    SequelizeClass.prototype.authenticate = wrapAsync(originalAuthenticate)
    SequelizeClass.prototype.authenticate.__hcUnitBlocked = true
  }
  if (typeof SequelizeClass.prototype.query === 'function' && !SequelizeClass.prototype.query.__hcUnitBlocked) {
    const originalQuery = SequelizeClass.prototype.query
    SequelizeClass.prototype.query = wrapAsync(originalQuery)
    SequelizeClass.prototype.query.__hcUnitBlocked = true
  }
  if (typeof SequelizeClass.prototype.sync === 'function' && !SequelizeClass.prototype.sync.__hcUnitBlocked) {
    const originalSync = SequelizeClass.prototype.sync
    SequelizeClass.prototype.sync = wrapAsync(originalSync)
    SequelizeClass.prototype.sync.__hcUnitBlocked = true
  }

  const managerPaths = [
    'sequelize/lib/dialects/mysql/connection-manager',
    'sequelize/lib/dialects/mariadb/connection-manager',
  ]
  for (const managerPath of managerPaths) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const Manager = require(managerPath)
      const proto = Manager.prototype
      if (!proto || typeof proto.connect !== 'function') continue
      if (proto.connect.__hcUnitBlocked) continue
      proto.connect = wrapAsync(proto.connect)
      proto.connect.__hcUnitBlocked = true
    } catch (_error) {
      // Dialect path may differ by sequelize version — mysql2 patch remains.
    }
  }
}

function applyUnitTestDbBlock() {
  process.env.HC_UNIT_TEST_BLOCK_DB = '1'
  blockMysqlDrivers()
  blockSequelizeMysql()
}

applyUnitTestDbBlock()

module.exports = {
  BLOCK_MSG,
  blockedError,
  blockMysqlDrivers,
  blockSequelizeMysql,
  applyUnitTestDbBlock,
  shouldBlock,
  forceReplaceFunction,
}
