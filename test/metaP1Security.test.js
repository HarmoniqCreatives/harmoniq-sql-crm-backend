'use strict'

/**
 * P1 Meta security unit tests (Facebook Page ownership + webhook HMAC).
 * Uses mocked Sequelize models only — never connects to harmoniq_creative_crm or any live DB.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { afterEach, beforeEach, describe, mock, test } = require('node:test')

process.env.NODE_ENV = 'test'
process.env.META_APP_SECRET = 'central-meta-app-secret'
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token'
process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex')

const { errors } = require('../src/utils/errors')
const { metaPageStatuses } = require('../src/utils/enums')
const {
  detectDuplicateConnectedPageOwners,
  findCanonicalConnectedPage,
  findForeignConnectedOwner,
  isConnectedPageOwnershipConflict,
  ownershipConflictReason,
} = require('../src/services/metaPageOwnership')

function signBody(raw, secret) {
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  return `sha256=${digest}`
}

describe('P1 Facebook Page global ownership', () => {
  test('same Page cannot be connected to two companies (foreign owner detected)', async () => {
    const MetaPage = {
      findOne: mock.fn(async () => ({
        id: 'page-a',
        companyId: 'company-a',
        pageId: 'fb-100',
        status: metaPageStatuses.connected,
      })),
    }
    const foreign = await findForeignConnectedOwner(MetaPage, 'fb-100', 'company-b', {
      transaction: { LOCK: { UPDATE: 'UPDATE' } },
    })
    assert.equal(foreign.companyId, 'company-a')
    assert.equal(ownershipConflictReason(), errors.metaPageOwnedByAnotherCompany)
  })

  test('same company can reconnect its own Page (no foreign owner)', async () => {
    const { Op } = require('sequelize')
    const MetaPage = {
      findOne: mock.fn(async () => null),
    }
    const foreign = await findForeignConnectedOwner(MetaPage, 'fb-100', 'company-a', {
      transaction: { LOCK: { UPDATE: 'UPDATE' } },
    })
    assert.equal(foreign, null)
    const where = MetaPage.findOne.mock.calls[0].arguments[0].where
    assert.equal(where.pageId, 'fb-100')
    assert.equal(where.status, metaPageStatuses.connected)
    assert.equal(where.companyId[Op.ne], 'company-a')
  })

  test('disconnected Page is free for reconnect under ownership policy', async () => {
    // findForeignConnectedOwner only matches status=connected, so disconnected owners are ignored.
    const MetaPage = {
      findOne: mock.fn(async (query) => {
        assert.equal(query.where.status, metaPageStatuses.connected)
        return null
      }),
    }
    const foreign = await findForeignConnectedOwner(MetaPage, 'fb-200', 'company-b')
    assert.equal(foreign, null)
  })

  test('concurrent connection attempts surface ownership unique conflict', () => {
    const raceError = {
      name: 'SequelizeUniqueConstraintError',
      message: "Duplicate entry 'fb-100' for key 'meta_pages_connected_page_uidx'",
      parent: {
        sqlMessage: "Duplicate entry 'fb-100' for key 'meta_pages_connected_page_uidx'",
      },
      fields: { connectedPageKey: 'fb-100' },
    }
    assert.equal(isConnectedPageOwnershipConflict(raceError), true)
    assert.equal(isConnectedPageOwnershipConflict({ name: 'SequelizeUniqueConstraintError', fields: { pageId: 'x' } }), false)
  })

  test('webhook resolves only the canonical (oldest) connected owner', async () => {
    const MetaPage = {
      findAll: mock.fn(async () => [
        { id: 'older', companyId: 'company-a', pageId: 'fb-100', connectionId: 'c1', createdAt: new Date('2024-01-01') },
        { id: 'newer', companyId: 'company-b', pageId: 'fb-100', connectionId: 'c2', createdAt: new Date('2024-06-01') },
      ]),
    }
    const page = await findCanonicalConnectedPage(MetaPage, 'fb-100')
    assert.equal(page.id, 'older')
    assert.equal(page.companyId, 'company-a')
  })

  test('detectDuplicateConnectedPageOwners reports without modifying records', async () => {
    const MetaPage = {
      findAll: mock.fn(async () => [
        { id: '1', pageId: 'fb-dup', companyId: 'a', createdAt: new Date('2024-01-01') },
        { id: '2', pageId: 'fb-dup', companyId: 'b', createdAt: new Date('2024-02-01') },
        { id: '3', pageId: 'fb-ok', companyId: 'a', createdAt: new Date('2024-03-01') },
      ]),
    }
    const dupes = await detectDuplicateConnectedPageOwners(MetaPage)
    assert.equal(dupes.length, 1)
    assert.equal(dupes[0].pageId, 'fb-dup')
    assert.deepEqual(dupes[0].companyIds, ['a', 'b'])
    assert.equal(MetaPage.findAll.mock.calls.length, 1)
  })
})

describe('P1 Meta webhook HMAC (central secret only)', () => {
  let previousSecret

  beforeEach(() => {
    previousSecret = process.env.META_APP_SECRET
    process.env.META_APP_SECRET = 'central-meta-app-secret'
    // Fresh require path: service reads env at call time for secret.
  })

  afterEach(() => {
    process.env.META_APP_SECRET = previousSecret
  })

  test('central Meta App Secret signature succeeds', () => {
    // Re-require after env set so module uses current secret at verify time (env read inside fn).
    delete require.cache[require.resolve('../src/services/metaWebhookService')]
    const { verifyWebhookSignature } = require('../src/services/metaWebhookService')
    const raw = Buffer.from('{"object":"page","entry":[]}')
    const header = signBody(raw, 'central-meta-app-secret')
    assert.equal(verifyWebhookSignature(raw, header), true)
  })

  test('another company App Secret signature fails', () => {
    delete require.cache[require.resolve('../src/services/metaWebhookService')]
    const { verifyWebhookSignature } = require('../src/services/metaWebhookService')
    const raw = Buffer.from('{"object":"page","entry":[]}')
    const header = signBody(raw, 'customer-company-secret')
    assert.equal(verifyWebhookSignature(raw, header), false)
  })

  test('invalid signature fails', () => {
    delete require.cache[require.resolve('../src/services/metaWebhookService')]
    const { verifyWebhookSignature } = require('../src/services/metaWebhookService')
    const raw = Buffer.from('{"object":"page","entry":[]}')
    assert.equal(verifyWebhookSignature(raw, 'sha256=deadbeef'), false)
    assert.equal(verifyWebhookSignature(raw, 'not-a-signature'), false)
    assert.equal(verifyWebhookSignature('not-a-buffer', signBody(Buffer.from('x'), 'central-meta-app-secret')), false)
  })

  test('missing central App Secret fails safely', () => {
    delete require.cache[require.resolve('../src/services/metaWebhookService')]
    const { verifyWebhookSignature } = require('../src/services/metaWebhookService')
    const raw = Buffer.from('{"object":"page","entry":[]}')
    const header = signBody(raw, 'central-meta-app-secret')
    delete process.env.META_APP_SECRET
    assert.equal(verifyWebhookSignature(raw, header), false)
    process.env.META_APP_SECRET = '   '
    assert.equal(verifyWebhookSignature(raw, header), false)
  })

  test('valid webhook event processing continues after successful verification', async () => {
    const modelsPath = require.resolve('../src/models')
    const webhookPath = require.resolve('../src/services/metaWebhookService')
    delete require.cache[modelsPath]
    delete require.cache[webhookPath]

    const created = []
    const MetaPage = {
      findAll: async () => ([
        {
          id: 'meta-page-1',
          companyId: 'company-a',
          connectionId: 'conn-1',
          pageId: 'fb-page-9',
          status: metaPageStatuses.connected,
          createdAt: new Date('2024-01-01'),
        },
      ]),
    }
    const MetaWebhookIngestion = {
      create: async (fields) => {
        created.push(fields)
        return fields
      },
    }

    // Stub getModels before loading the service — never opens a DB connection.
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: {
        getModels: () => ({ MetaPage, MetaWebhookIngestion }),
      },
    }

    const {
      verifyWebhookSignature,
      acceptWebhookPayload,
      buildDedupeKey,
    } = require('../src/services/metaWebhookService')

    process.env.META_APP_SECRET = 'central-meta-app-secret'
    const payload = {
      object: 'page',
      entry: [{
        id: 'fb-page-9',
        changes: [{
          field: 'leadgen',
          value: {
            page_id: 'fb-page-9',
            leadgen_id: 'lead-99',
            form_id: 'form-1',
          },
        }],
      }],
    }
    const raw = Buffer.from(JSON.stringify(payload))
    assert.equal(verifyWebhookSignature(raw, signBody(raw, process.env.META_APP_SECRET)), true)

    await acceptWebhookPayload(payload)
    assert.equal(created.length, 1)
    assert.equal(created[0].companyId, 'company-a')
    assert.equal(created[0].metaPageId, 'meta-page-1')
    assert.equal(created[0].status, 'pending')
    assert.equal(created[0].dedupeKey, buildDedupeKey('company-a', 'fb-page-9', 'lead-99'))
  })
})
