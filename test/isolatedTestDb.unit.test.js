'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  evaluateIsolatedTestDb,
  isolatedTestDbConfigured,
  looksLikeProductionDbName,
  looksLikeIsolatedTestDbName,
  resolveApplicationDbName,
  applyIsolatedTestDbEnv,
  isUnitTestDbBlocked,
  assertMysqlAccessAllowed,
} = require('./helpers/isolatedTestDb')
test('rejects missing DB_NAME_TEST', () => {
  const result = evaluateIsolatedTestDb({
    DB_NAME: 'harmoniq_creative_crm_local',
    DB_NAME_TEST: '',
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /DB_NAME_TEST is not set/)
  assert.equal(isolatedTestDbConfigured({
    DB_NAME: 'harmoniq_creative_crm_local',
    DB_NAME_TEST: '',
  }), false)
})

test('rejects equal application and test DB names', () => {
  const result = evaluateIsolatedTestDb({
    DB_NAME: 'harmoniq_creative_crm_test',
    DB_NAME_TEST: 'harmoniq_creative_crm_test',
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /must differ/)
})

test('rejects equal names via DB_NAME_APP snapshot', () => {
  const result = evaluateIsolatedTestDb({
    DB_NAME: 'harmoniq_creative_crm_test',
    DB_NAME_TEST: 'harmoniq_creative_crm_test',
    DB_NAME_APP: 'harmoniq_creative_crm_test',
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /must differ/)
})

test('rejects production-like test DB names', () => {
  const cases = [
    'harmoniq_creative_crm_live',
    'harmoniq_creative_crm_prod',
    'harmoniq_creative_crm_production',
    'production',
    'crm_live',
  ]
  for (const name of cases) {
    assert.equal(looksLikeProductionDbName(name), true, name)
    assert.equal(looksLikeIsolatedTestDbName(name), false, name)
    const result = evaluateIsolatedTestDb({
      DB_NAME: 'harmoniq_creative_crm_local',
      DB_NAME_TEST: name,
    })
    assert.equal(result.ok, false, name)
    assert.match(result.reason, /production\/live|test" segment/i, name)
  }
})

test('accepts legitimate isolated test DB names', () => {
  const cases = [
    'harmoniq_creative_crm_test',
    'hc_test',
    'filos_crm_test',
    'crm_live_test', // clone named from live but clearly a test DB (ends with test)
  ]
  for (const name of cases) {
    assert.equal(looksLikeProductionDbName(name), false, name)
    assert.equal(looksLikeIsolatedTestDbName(name), true, name)
    const result = evaluateIsolatedTestDb({
      DB_NAME: 'harmoniq_creative_crm_local',
      DB_NAME_TEST: name,
    })
    assert.equal(result.ok, true, name)
  }
})

test('accepts distinct test database after remap snapshot', () => {
  const env = {
    DB_NAME: 'harmoniq_creative_crm_test',
    DB_NAME_TEST: 'harmoniq_creative_crm_test',
    DB_NAME_APP: 'harmoniq_creative_crm_local',
  }
  const result = evaluateIsolatedTestDb(env)
  assert.equal(result.ok, true)
  assert.equal(result.appName, 'harmoniq_creative_crm_local')
  assert.equal(isolatedTestDbConfigured(env), true)
  assert.equal(resolveApplicationDbName(env), 'harmoniq_creative_crm_local')
})

test('applyIsolatedTestDbEnv snapshots app name then remaps DB_NAME', () => {
  const env = {
    DB_NAME: 'harmoniq_creative_crm_local',
    DB_NAME_TEST: 'harmoniq_creative_crm_test',
  }
  const remapped = applyIsolatedTestDbEnv(env)
  assert.equal(remapped, 'harmoniq_creative_crm_test')
  assert.equal(env.DB_NAME, 'harmoniq_creative_crm_test')
  assert.equal(env.DB_NAME_APP, 'harmoniq_creative_crm_local')
  assert.equal(env.NODE_ENV, 'test')
  assert.equal(evaluateIsolatedTestDb(env).ok, true)
})

test('rejects names that end with a live/prod segment even if they contain test', () => {
  assert.equal(looksLikeProductionDbName('crm_test_live'), true)
  assert.equal(looksLikeIsolatedTestDbName('crm_test_live'), false)
  const result = evaluateIsolatedTestDb({
    DB_NAME: 'harmoniq_creative_crm_local',
    DB_NAME_TEST: 'crm_test_live',
  })
  assert.equal(result.ok, false)
})

test('unit-test DB block helpers detect flag and throw', () => {
  assert.equal(isUnitTestDbBlocked({}), false)
  assert.equal(isUnitTestDbBlocked({ HC_UNIT_TEST_BLOCK_DB: '1' }), true)
  assert.doesNotThrow(() => assertMysqlAccessAllowed({ HC_UNIT_TEST_BLOCK_DB: '0' }))
  assert.throws(
    () => assertMysqlAccessAllowed({ HC_UNIT_TEST_BLOCK_DB: '1' }),
    /MySQL access is blocked/,
  )
})

test('attempted Sequelize access is blocked when unit DB block is active', async () => {
  const previous = process.env.HC_UNIT_TEST_BLOCK_DB
  process.env.HC_UNIT_TEST_BLOCK_DB = '1'
  const { applyUnitTestDbBlock } = require('./helpers/blockDbConnections')
  applyUnitTestDbBlock()
  try {
    const database = require('../src/config/database')
    assert.throws(
      () => database.getSequelize(),
      /MySQL access is blocked during unit tests/,
    )
    assert.throws(
      () => database.assertMysqlAccessAllowed(),
      /MySQL access is blocked during unit tests/,
    )
    await assert.rejects(
      () => database.assertDatabaseConnection(),
      /MySQL access is blocked during unit tests/,
    )
    // closeDatabase must not attempt MySQL I/O under the block
    await database.closeDatabase()
  } finally {
    if (previous === undefined) delete process.env.HC_UNIT_TEST_BLOCK_DB
    else process.env.HC_UNIT_TEST_BLOCK_DB = previous
  }
})

test('mysql2 and mysql2/promise entry points cannot open connections under unit DB block', async () => {
  const previous = process.env.HC_UNIT_TEST_BLOCK_DB
  process.env.HC_UNIT_TEST_BLOCK_DB = '1'
  const { applyUnitTestDbBlock } = require('./helpers/blockDbConnections')
  applyUnitTestDbBlock()
  try {
    const mysql = require('mysql2')
    const mysqlPromise = require('mysql2/promise')
    const forbiddenConfig = {
      host: '127.0.0.1',
      user: 'blocked',
      password: 'blocked',
      database: 'must_not_connect',
    }
    assert.throws(() => mysql.createConnection(forbiddenConfig), /MySQL access is blocked/)
    assert.throws(() => mysql.createPool(forbiddenConfig), /MySQL access is blocked/)
    assert.throws(() => mysql.createPoolCluster(), /MySQL access is blocked/)
    assert.throws(() => new mysql.Connection(forbiddenConfig), /MySQL access is blocked/)
    await assert.rejects(() => mysqlPromise.createConnection(forbiddenConfig), /MySQL access is blocked/)
    await assert.rejects(() => mysqlPromise.createPool(forbiddenConfig), /MySQL access is blocked/)
  } finally {
    if (previous === undefined) delete process.env.HC_UNIT_TEST_BLOCK_DB
    else process.env.HC_UNIT_TEST_BLOCK_DB = previous
  }
})

test('direct Sequelize MySQL authenticate is blocked without using getSequelize', async () => {
  const previous = process.env.HC_UNIT_TEST_BLOCK_DB
  process.env.HC_UNIT_TEST_BLOCK_DB = '1'
  const { applyUnitTestDbBlock } = require('./helpers/blockDbConnections')
  applyUnitTestDbBlock()
  try {
    const { Sequelize } = require('sequelize')
    // Deliberate bypass of getSequelize — must still be blocked before any socket opens.
    const rogue = new Sequelize('must_not_connect', 'blocked', 'blocked', {
      host: '127.0.0.1',
      port: 3306,
      dialect: 'mysql',
      logging: false,
      pool: { max: 1, min: 0, idle: 1000, acquire: 1000 },
    })
    await assert.rejects(
      () => rogue.authenticate(),
      /MySQL access is blocked/,
    )
    await assert.rejects(
      () => rogue.query('SELECT 1'),
      /MySQL access is blocked/,
    )
  } finally {
    if (previous === undefined) delete process.env.HC_UNIT_TEST_BLOCK_DB
    else process.env.HC_UNIT_TEST_BLOCK_DB = previous
  }
})
