/* eslint-env mocha */
// vote-comments: verifyClaim stores the optional memo; cancelClaim mirrors the contract's cancel.
// Runs against a scratch database (vc_es_test) it creates and drops itself.
process.env.NODE_ENV = process.env.NODE_ENV || 'dev'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { Client } = require(require.resolve('pg', { paths: [require.resolve('pg-promise')] }))
const massive = require('massive')

// community.js destructures logError at require time, so stub it first.
const logging = require('../src/logging')
const loggedErrors = []
logging.logError = (message, error) => loggedErrors.push({ message, error })

// Load a private copy of community.js (with this file's logError stub) and evict it afterwards,
// so other suites that stub logError themselves get their own copy regardless of load order.
const communityPath = require.resolve('../src/updaters/community')
delete require.cache[communityPath]
const { verifyClaim, cancelClaim } = require('../src/updaters/community')
delete require.cache[communityPath]

const SCRATCH_DB = 'vc_es_test'
const PG = { host: 'localhost', port: 5432, user: 'postgres', password: '' }
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'fixtures/claims_schema.sql'), 'utf8')

let db
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

async function seedClaim (status = 'pending') {
  await db.users.insert([{ account: 'claimer' }, { account: 'validator' }])
  await db.actions.insert({ id: 7, verifications: 3, usages: 0, usages_left: 0 })
  await db.claims.insert({ id: 1, action_id: 7, claimer_id: 'claimer', status })
}

function chainAction (data, at = '2026-11-03T12:00:00.500Z') {
  txCounter += 1
  return {
    payload: { transactionId: `tx${txCounter}`, authorization: [{ actor: data.verifier || data.claimer }], data },
    blockInfo: { blockNumber: 200 + txCounter, timestamp: new Date(at) }
  }
}

async function vote (extra) {
  const { payload, blockInfo } = chainAction({ claim_id: 1, verifier: 'validator', vote: 1, ...extra })
  await verifyClaim(db, payload, blockInfo, {})
}

async function cancel (claimId = 1) {
  const { payload, blockInfo } = chainAction({ community_id: 'TST', claim_id: claimId, claimer: 'claimer' })
  await cancelClaim(db, payload, blockInfo, {})
  return blockInfo
}

describe('vote comments and cancel (vote-comments)', function () {
  this.timeout(20000)

  before(async function () {
    await adminQuery(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
    await adminQuery(`CREATE DATABASE ${SCRATCH_DB}`)
    const client = new Client({ ...PG, database: SCRATCH_DB })
    await client.connect()
    await client.query(SCHEMA_SQL)
    await client.end()
    db = await massive({ ...PG, database: SCRATCH_DB, max: 3 })
  })

  after(async function () {
    if (db) await db.instance.$pool.end()
    await adminQuery(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
  })

  beforeEach(async function () {
    await db.instance.none('TRUNCATE checks, claims, actions, users, member_action_claims RESTART IDENTITY CASCADE')
    loggedErrors.length = 0
    await seedClaim()
  })

  it('verifyClaim stores the memo', async function () {
    await vote({ memo: '📷 Foto escura' })
    assert.strictEqual((await db.checks.findOne({ claim_id: 1 })).memo, '📷 Foto escura')
  })

  it('verifyClaim with no memo field stores null', async function () {
    await vote({})
    assert.strictEqual((await db.checks.findOne({ claim_id: 1 })).memo, null)
  })

  it('verifyClaim with an empty memo stores null', async function () {
    await vote({ memo: '' })
    assert.strictEqual((await db.checks.findOne({ claim_id: 1 })).memo, null)
  })

  it('verifyClaim strips a NUL byte from the memo', async function () {
    await vote({ memo: 'a\u0000b' })
    assert.strictEqual((await db.checks.findOne({ claim_id: 1 })).memo, 'ab')
  })

  it('verifyClaim with a memo of only a NUL byte stores null', async function () {
    await vote({ memo: '\u0000' })
    assert.strictEqual((await db.checks.findOne({ claim_id: 1 })).memo, null)
  })

  it('a replayed verifyClaim never un-cancels a claim', async function () {
    await cancel()
    await vote({ memo: 'late' })

    assert.strictEqual((await db.claims.findOne(1)).status, 'cancelled')
    assert.strictEqual((await db.checks.findOne({ claim_id: 1 })).memo, 'late')
  })

  it('cancelClaim stamps last_tx and last_eos_account', async function () {
    const { payload, blockInfo } = chainAction({ community_id: 'TST', claim_id: 1, claimer: 'claimer' })
    await cancelClaim(db, payload, blockInfo, {})

    const claim = await db.claims.findOne(1)
    assert.strictEqual(claim.last_tx, payload.transactionId)
    assert.strictEqual(claim.last_eos_account, 'claimer')
  })

  it('cancelClaim sets the claim to cancelled and closes the tally', async function () {
    await db.member_action_claims.insert({ account: 'claimer', action_id: 7, pending: 1, approved: 2 })
    const blockInfo = await cancel()

    assert.strictEqual((await db.claims.findOne(1)).status, 'cancelled')
    const [row] = await db.instance.query(
      `SELECT pending, approved, to_char(last_rejected_at, 'YYYY-MM-DD HH24:MI:SS') AS rejected
         FROM member_action_claims WHERE account = 'claimer' AND action_id = 7`)
    assert.strictEqual(row.pending, 0)
    assert.strictEqual(row.approved, 2)
    assert.strictEqual(row.rejected, blockInfo.timestamp.toISOString().slice(0, 19).replace('T', ' '))
  })

  it('cancelClaim on a missing claim logs and skips', async function () {
    await db.member_action_claims.insert({ account: 'claimer', action_id: 7, pending: 1, approved: 2 })
    await cancel(99)

    assert.strictEqual((await db.claims.findOne(1)).status, 'pending')
    const row = await db.member_action_claims.findOne({ account: 'claimer', action_id: 7 })
    assert.strictEqual(row.pending, 1)
    assert.strictEqual(loggedErrors.length, 1)
  })

  it('cancelClaim on a claim that is not pending skips', async function () {
    await db.claims.update(1, { status: 'approved' })
    await db.member_action_claims.insert({ account: 'claimer', action_id: 7, pending: 0, approved: 2 })
    await cancel()

    assert.strictEqual((await db.claims.findOne(1)).status, 'approved')
    const row = await db.member_action_claims.findOne({ account: 'claimer', action_id: 7 })
    assert.strictEqual(row.pending, 0)
    assert.strictEqual(row.approved, 2)
    assert.strictEqual(row.last_rejected_at, null)
  })
})
