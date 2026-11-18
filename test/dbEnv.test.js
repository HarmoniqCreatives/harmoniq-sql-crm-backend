'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const { resolveDatabaseConfig } = require('../src/config/dbEnv')

function baseLocal(overrides = {}) {
  return {
    NODE_ENV: 'development',
    DB_ENV: 'local',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'any_local_database',
    DB_USER: 'harmoniq',
    DB_PASSWORD: 'secret',
    DB_LOGGING: '0',
    ...overrides,
  }
}

function baseProduction(overrides = {}) {
  return {
    NODE_ENV: 'production',
    DB_ENV: 'production',
    DB_HOST: 'db.example.com',
    DB_PORT: '3306',
    DB_NAME: 'any_production_database',
    DB_USER: 'harmoniq_live',
    DB_PASSWORD: 'secret',
    DB_LOGGING: '0',
    ...overrides,
  }
}

describe('resolveDatabaseConfig', () => {
  it('accepts valid local configuration with any non-empty DB_NAME', () => {
    const cfg = resolveDatabaseConfig(baseLocal({ DB_NAME: 'harmoniq_creative_crm' }))
    assert.equal(cfg.dbEnv, 'local')
    assert.equal(cfg.name, 'harmoniq_creative_crm')
    assert.equal(cfg.host, '127.0.0.1')
    assert.equal(cfg.port, 3306)
    assert.equal(cfg.dialect, 'mysql')
  })

  it('accepts valid local + NODE_ENV=test', () => {
    const cfg = resolveDatabaseConfig(baseLocal({ NODE_ENV: 'test', DB_NAME: 'test_db' }))
    assert.equal(cfg.nodeEnv, 'test')
    assert.equal(cfg.name, 'test_db')
  })

  it('accepts valid production configuration with any non-empty DB_NAME', () => {
    const cfg = resolveDatabaseConfig(baseProduction({ DB_NAME: 'prod_crm' }))
    assert.equal(cfg.dbEnv, 'production')
    assert.equal(cfg.name, 'prod_crm')
  })

  it('uses DB_NAME from env without rewriting it', () => {
    const cfg = resolveDatabaseConfig(baseLocal({ DB_NAME: 'custom_name_123' }))
    assert.equal(cfg.name, 'custom_name_123')
  })

  it('rejects missing DB_ENV', () => {
    assert.throws(
      () => resolveDatabaseConfig(baseLocal({ DB_ENV: '' })),
      /DB_ENV/,
    )
  })

  it('rejects missing DB_NAME', () => {
    assert.throws(
      () => resolveDatabaseConfig(baseLocal({ DB_NAME: '' })),
      /DB_NAME/,
    )
  })

  it('rejects DB_ENV=local with NODE_ENV=production', () => {
    assert.throws(
      () => resolveDatabaseConfig(baseLocal({ NODE_ENV: 'production' })),
      /incompatible/,
    )
  })

  it('rejects DB_ENV=production with NODE_ENV=development', () => {
    assert.throws(
      () => resolveDatabaseConfig(baseProduction({ NODE_ENV: 'development' })),
      /NODE_ENV=production/,
    )
  })

  it('rejects missing DB_PASSWORD', () => {
    assert.throws(
      () => resolveDatabaseConfig(baseLocal({ DB_PASSWORD: '' })),
      /DB_PASSWORD/,
    )
  })
})
