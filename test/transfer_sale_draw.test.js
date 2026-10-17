/* eslint-env mocha */
// S5a-es (plan §9.2): transferSale draws Elm purchases of batch offers from the live batch.
// Runs against a scratch database (s5a_es_test) it creates and drops itself.
process.env.NODE_ENV = process.env.NODE_ENV || 'dev'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
// The pg that massive's pg-promise runs on (the top-level `pg` is an older, unused copy).
const { Client } = require(require.resolve('pg', { paths: [require.resolve('pg-promise')] }))
const massive = require('massive')

// community.js destructures logError at require time, so stub it first.
const logging = require('../src/logging')
const loggedErrors = []
logging.logError = (message, error) => loggedErrors.push({ message, error })

const { transferSale, checkDrawFunction } = require('../src/updaters/community')
const { ResolveError } = require('../src/chain')
const { generate } = require('./fixtures/generate_s5_schema')
const manifest = require('./fixtures/written_columns.json')

const SCRATCH_DB = 's5a_es_test'
const PG = { host: 'localhost', port: 5432, user: 'postgres', password: '' }
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'fixtures/s5_schema.sql'), 'utf8')

const DRAW_FUNCTION_SQL = SCHEMA_SQL.match(/CREATE FUNCTION public\.shop_draw_from_batch[\s\S]*?END \$\$;/)[0]

let db
let queries
let txCounter = 0

async function adminQuery (sql) {
  const client = new Client({ ...PG, database: 'postgres' })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

function scratchClient () {
  return new Client({ ...PG, database: SCRATCH_DB })
}

async function insertProduct (fields = {}) {
  return db.products.insert({
    title: 'Batch cake',
    units: null,
    track_stock: false,
    availability: 'batches',
    ...fields
  })
}

async function insertBatch (productId, fields = {}) {
  return db.product_batches.insert({
    product_id: productId,
    quantity: 10,
    remaining: 10,
    opens_at: '2026-10-20 03:00:00',
    closes_at: '2026-10-22 03:00:00',
    ...fields
  })
}

function purchase (productId, { units = 2, at = '2026-10-21T12:00:00Z' } = {}) {
  txCounter += 1
  const payload = {
    transactionId: `tx${txCounter}`,
    authorization: [{ actor: 'buyer' }],
    data: { from: 'buyer', to: 'seller', quantity: '10.0000 TST', units, sale_id: productId }
  }
  const blockInfo = { blockNumber: 100 + txCounter, timestamp: new Date(at) }
  return { payload, blockInfo }
}

async function buy (productId, opts) {
  const { payload, blockInfo } = purchase(productId, opts)
  await transferSale(db, payload, blockInfo, {})
  return payload
}

async function itemFor (payload) {
  const [item] = await db.instance.query(
    `SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_tx = $1`,
    [payload.transactionId]
  )
  return item
}

async function remaining (batchId) {
  return (await db.product_batches.findOne(batchId)).remaining
}

describe('transferSale draws from the live batch (S5a-es)', function () {
  this.timeout(20000)

  before(async function () {
    await adminQuery(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
    await adminQuery(`CREATE DATABASE ${SCRATCH_DB}`)
    // Short deadlock detection so the forced-deadlock case is fast.
    await adminQuery(`ALTER DATABASE ${SCRATCH_DB} SET deadlock_timeout = '500ms'`)
    const client = scratchClient()
    await client.connect()
    await client.query(SCHEMA_SQL)
    await client.end()

    queries = []
    db = await massive({ ...PG, database: SCRATCH_DB, max: 3 }, {}, {
      query: e => queries.push(e.query)
    })
  })

  after(async function () {
    if (db) await db.instance.$pool.end()
    await adminQuery(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
  })

  beforeEach(async function () {
    await db.instance.none('TRUNCATE order_items, orders, product_batches, products, _processed_actions RESTART IDENTITY CASCADE')
    queries.length = 0
    loggedErrors.length = 0
  })

  // AT-e13: the schema stub is generated from written_columns.json
  it('the committed schema stub matches the manifest generator', function () {
    assert.strictEqual(SCHEMA_SQL, generate())
  })

  // AT-e10: a purchase that fits is drawn from the live batch
  it('draws a purchase that fits', async function () {
    const product = await insertProduct()
    const batch = await insertBatch(product.id)
    const item = await itemFor(await buy(product.id, { units: 3 }))

    assert.strictEqual(item.draw_outcome, 'drawn')
    assert.strictEqual(String(item.batch_id), String(batch.id))
    assert.strictEqual(item.quantity, 3)
    assert.strictEqual(await remaining(batch.id), 7)
    assert.strictEqual((await db.products.findOne(product.id)).units, null)
    assert.strictEqual(loggedErrors.length, 0)
  })

  // AT-e10: a purchase larger than what remains is recorded unassigned
  it('records a purchase larger than the remainder as no_fit', async function () {
    const product = await insertProduct()
    const batch = await insertBatch(product.id, { remaining: 1 })
    const item = await itemFor(await buy(product.id, { units: 2 }))

    assert.strictEqual(item.draw_outcome, 'no_fit')
    assert.strictEqual(item.batch_id, null)
    assert.strictEqual(await remaining(batch.id), 1)
    assert.strictEqual(await db.orders.count({ product_id: product.id }) | 0, 1)
  })

  // AT-e10: the window is judged at the block's time in the batch's local day, São Paulo (UTC-3)
  // and Costa Rica (UTC-6): last day's closes_at is local midnight, stored as UTC wall time.
  const zones = [
    { name: 'São Paulo', closesAt: '2026-10-22 03:00:00', before: '2026-10-22T02:59:58Z', after: '2026-10-22T03:00:02Z' },
    { name: 'Costa Rica', closesAt: '2026-10-22 06:00:00', before: '2026-10-22T05:59:58Z', after: '2026-10-22T06:00:02Z' }
  ]
  zones.forEach(zone => {
    it(`draws at 23:59:58 local on the last day and not at 00:00:02 next day (${zone.name})`, async function () {
      const product = await insertProduct()
      const batch = await insertBatch(product.id, {
        opens_at: zone.closesAt.replace('22', '20'),
        closes_at: zone.closesAt
      })

      const inside = await itemFor(await buy(product.id, { units: 1, at: zone.before }))
      assert.strictEqual(inside.draw_outcome, 'drawn')
      assert.strictEqual(String(inside.batch_id), String(batch.id))

      const outside = await itemFor(await buy(product.id, { units: 1, at: zone.after }))
      assert.strictEqual(outside.draw_outcome, 'no_fit')
      assert.strictEqual(outside.batch_id, null)
      assert.strictEqual(await remaining(batch.id), 9)
    })
  })

  // AT-e10: a closed batch is never drawn from
  it('records a purchase against a closed batch as no_fit', async function () {
    const product = await insertProduct()
    const batch = await insertBatch(product.id, { closed_at: '2026-10-21 10:00:00' })
    const item = await itemFor(await buy(product.id))

    assert.strictEqual(item.draw_outcome, 'no_fit')
    assert.strictEqual(item.batch_id, null)
    assert.strictEqual(await remaining(batch.id), 10)
  })

  // AT-e11: a deadlock inside the savepoint is retried and the purchase is then drawn.
  // Connection B holds the batch row; the draw (A) takes the product lock then waits on that
  // row; B then asks for the product lock. Postgres aborts A (B's own deadlock_timeout is
  // huge, so A's check is the one that finds the cycle), the savepoint rolls back, and
  // A's retry succeeds once B has committed.
  it('retries a forced deadlock and then draws', async function () {
    const product = await insertProduct()
    const batch = await insertBatch(product.id)

    const b = scratchClient()
    await b.connect()
    try {
      await b.query(`SET deadlock_timeout = '1h'`)
      await b.query('BEGIN')
      await b.query('UPDATE product_batches SET label = $1 WHERE id = $2', ['held', batch.id])

      const sale = buy(product.id, { units: 2 })

      // Wait until the draw is blocked on B's row lock, then close the cycle.
      const deadline = Date.now() + 10000
      for (;;) {
        const { rows } = await b.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
          [SCRATCH_DB]
        )
        if (rows.length > 0) break
        assert.ok(Date.now() < deadline, 'the draw never blocked')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const bLock = b.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [product.id])
        .then(() => b.query('COMMIT'))

      const payload = await sale
      await bLock

      const item = await itemFor(payload)
      assert.strictEqual(item.draw_outcome, 'drawn')
      assert.strictEqual(String(item.batch_id), String(batch.id))
      assert.strictEqual(await remaining(batch.id), 8)
      const draws = queries.filter(q => /SELECT public\.shop_draw_from_batch\(/.test(q))
      assert.ok(draws.length >= 2, `expected a retried draw, saw ${draws.length} call(s)`)
      assert.strictEqual(loggedErrors.length, 0)
      assert.strictEqual(await db.orders.count({ product_id: product.id }) | 0, 1)
    } finally {
      await b.end()
    }
  })

  // Keeps connection B's batch-row lock and, every time the draw is blocked on it, closes a
  // deadlock cycle (B asks for the product lock, the draw is the victim), then releases the
  // product lock again so the next attempt can start. Runs until `until` settles.
  async function deadlockEveryAttempt (b, productId, until) {
    let finished = false
    until.then(() => { finished = true }, () => { finished = true })
    while (!finished) {
      const { rows } = await b.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        [SCRATCH_DB]
      )
      if (rows.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 5))
        continue
      }
      await b.query('SAVEPOINT attempt')
      await b.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [productId])
      await b.query('ROLLBACK TO attempt')
    }
  }

  // AT-e11: with the deadlock forced on every attempt the draw is retried three times, then the
  // order is recorded with 'error', the outer transaction commits and nothing throws
  it('records error after three retries when every attempt deadlocks', async function () {
    const product = await insertProduct()
    const batch = await insertBatch(product.id)

    const b = scratchClient()
    await b.connect()
    try {
      await b.query(`SET deadlock_timeout = '1h'`)
      await b.query('BEGIN')
      await b.query('UPDATE product_batches SET label = $1 WHERE id = $2', ['held', batch.id])

      const sale = buy(product.id, { units: 2 })
      const driver = deadlockEveryAttempt(b, product.id, sale)
      const payload = await sale
      await driver
      await b.query('COMMIT')

      const item = await itemFor(payload)
      assert.strictEqual(item.draw_outcome, 'error')
      assert.strictEqual(item.batch_id, null)
      assert.strictEqual(await remaining(batch.id), 10)
      assert.strictEqual(await db.orders.count({ product_id: product.id }) | 0, 1)
      assert.strictEqual(queries.filter(q => /SELECT public\.shop_draw_from_batch\(/.test(q)).length, 4)
      assert.strictEqual(loggedErrors.length, 1)
      assert.strictEqual(loggedErrors[0].message, 'S5 draw failed; order recorded unassigned')
      assert.strictEqual(loggedErrors[0].error.code, '40P01')
    } finally {
      await b.end()
    }
  })

  // AT-e18: a product lock held by another connection makes the draw fail with 55P03 after 2s,
  // retry, and end 'error' without stalling the indexer
  it('fails soft with error when the product lock is held (55P03)', async function () {
    this.timeout(30000)
    const product = await insertProduct()
    const batch = await insertBatch(product.id)

    const b = scratchClient()
    await b.connect()
    try {
      await b.query('BEGIN')
      await b.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [product.id])

      const started = Date.now()
      const payload = await buy(product.id)
      const elapsed = Date.now() - started
      await b.query('ROLLBACK')

      // four attempts at 2s each plus three 50 ms pauses: bounded, not stalled
      assert.ok(elapsed >= 7500 && elapsed < 15000, `took ${elapsed}ms`)
      const item = await itemFor(payload)
      assert.strictEqual(item.draw_outcome, 'error')
      assert.strictEqual(item.batch_id, null)
      assert.strictEqual(await remaining(batch.id), 10)
      assert.strictEqual(queries.filter(q => /SELECT public\.shop_draw_from_batch\(/.test(q)).length, 4)
      assert.strictEqual(loggedErrors[0].error.code, '55P03')
    } finally {
      await b.end()
    }
  })

  // AT-e10: the same payload twice leaves one order and one draw
  it('records one order and one draw for a replayed payload', async function () {
    const product = await insertProduct()
    const batch = await insertBatch(product.id)
    const { payload, blockInfo } = purchase(product.id, { units: 4 })

    await transferSale(db, payload, blockInfo, {})
    await transferSale(db, payload, blockInfo, {})

    assert.strictEqual(await db.orders.count({ product_id: product.id }) | 0, 1)
    assert.strictEqual(await db.order_items.count({ product_id: product.id }) | 0, 1)
    assert.strictEqual(await remaining(batch.id), 6)
  })

  // AT-e18: a purchase of a soft-deleted offer is still recorded (drawn if it fits); a missing product is a ResolveError
  it('records a purchase of a deleted offer and raises ResolveError for a missing one', async function () {
    const product = await insertProduct({ is_deleted: true })
    await insertBatch(product.id)
    const item = await itemFor(await buy(product.id, { units: 1 }))
    assert.strictEqual(item.draw_outcome, 'drawn')

    await assert.rejects(buy(999999), ResolveError)
    assert.strictEqual(await db.orders.count({ product_id: 999999 }) | 0, 0)
  })

  // AT-e18: a non-batch offer's order_items insert carries no batch_id or draw_outcome key
  it('writes no batch_id or draw_outcome for a stock offer and still decrements units', async function () {
    const product = await insertProduct({ availability: 'stock', track_stock: true, units: 5 })
    await buy(product.id, { units: 2 })

    assert.strictEqual((await db.products.findOne(product.id)).units, 3)
    const itemInsert = queries.find(q => /INSERT INTO "?order_items"?/i.test(q))
    assert.ok(itemInsert, 'no order_items insert seen')
    assert.ok(!/batch_id|draw_outcome/.test(itemInsert), itemInsert)
    assert.ok(!queries.some(q => /shop_draw_from_batch/.test(q)))
    const [item] = await db.order_items.find({ product_id: product.id })
    assert.strictEqual(item.draw_outcome, null)
    assert.strictEqual(item.batch_id, null)
  })

  // AT-e13: transferSale writes only columns listed in written_columns.json
  it('writes only manifest columns', async function () {
    const stockProduct = await insertProduct({ availability: 'stock', track_stock: true, units: 5 })
    const batchProduct = await insertProduct()
    await insertBatch(batchProduct.id)
    await buy(stockProduct.id)
    await buy(batchProduct.id)

    const written = { orders: new Set(), order_items: new Set(), products: new Set() }
    queries.forEach(q => {
      let m = q.match(/INSERT INTO "?(orders|order_items)"?\s*\(([^)]*)\)/i)
      if (m) m[2].split(',').forEach(c => written[m[1]].add(c.replace(/["\s]/g, '')))
      m = q.match(/UPDATE "?products"?\s+SET\s+(.*?)\s+WHERE/is)
      if (m) m[1].split(',').forEach(c => written.products.add(c.split('=')[0].replace(/["\s]/g, '')))
    })
    assert.ok(written.orders.size > 0 && written.order_items.size > 0 && written.products.size > 0, 'no writes captured')
    Object.keys(written).forEach(table => {
      written[table].forEach(column => {
        assert.ok(column in manifest[table].columns, `${table}.${column} is written but not in written_columns.json`)
      })
    })
  })

  // AT-e09: with the draw function dropped the order is recorded unassigned with 'error',
  // the error is logged, nothing is thrown, and the startup check reports the function missing
  describe('draw function missing', function () {
    afterEach(async function () {
      await db.instance.none(`DROP FUNCTION IF EXISTS public.shop_draw_from_batch(bigint, integer, timestamp)`)
      await db.instance.none(DRAW_FUNCTION_SQL)
      await db.instance.none('ALTER TABLE order_items DROP COLUMN IF EXISTS draw_outcome')
      await db.instance.none('ALTER TABLE order_items ADD COLUMN draw_outcome character varying')
      await db.instance.none(`ALTER TABLE order_items ADD CONSTRAINT order_items_draw_outcome_check CHECK (draw_outcome IN ('drawn', 'no_fit', 'error'))`)
    })

    // AT-e18: with order_items.draw_outcome missing, the startup check reports it
    it('the startup check reports a missing draw_outcome column', async function () {
      await db.instance.none('ALTER TABLE order_items DROP COLUMN draw_outcome')
      const lines = []
      const originalLog = console.error
      console.error = (...args) => lines.push(args.join(' '))
      try {
        assert.strictEqual(await checkDrawFunction(db), false)
      } finally {
        console.error = originalLog
      }
      assert.ok(lines.some(l => l.includes('S5 draw function missing')), lines.join('\n'))
    })

    it('fails soft with draw_outcome error and the startup check says so', async function () {
      const product = await insertProduct()
      await insertBatch(product.id)
      assert.strictEqual(await checkDrawFunction(db), true)

      await db.instance.none('DROP FUNCTION public.shop_draw_from_batch(bigint, integer, timestamp)')
      const lines = []
      const originalLog = console.error
      console.error = (...args) => lines.push(args.join(' '))
      let payload
      try {
        payload = await buy(product.id)
        assert.strictEqual(await checkDrawFunction(db), false)
      } finally {
        console.error = originalLog
      }

      const item = await itemFor(payload)
      assert.strictEqual(item.draw_outcome, 'error')
      assert.strictEqual(item.batch_id, null)
      assert.strictEqual(await db.orders.count({ product_id: product.id }) | 0, 1)
      assert.ok(loggedErrors.some(e => e.message === 'S5 draw failed; order recorded unassigned'))
      // once from the re-check after the draw error, once from the explicit startup check
      assert.ok(lines.filter(l => l.includes('S5 draw function missing')).length >= 2, lines.join('\n'))
    })
  })
})
