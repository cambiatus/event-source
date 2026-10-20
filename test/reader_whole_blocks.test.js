/* eslint-env mocha */
// GetActionsReader hands a block over once, whole. A fake history node serves get_info and
// get_actions from per-contract row lists, so the tests script what the node knew at each poll.
const assert = require('assert')
const { GetActionsReader } = require('../src/GetActionsReader')

const CONTRACTS = ['cambiatus.cm', 'cambiatus.tk', 'cambiatus.es']
let nextGlobal = 1

function row (contract, name, blockNum, seq) {
  return {
    block_num: blockNum,
    block_time: '2026-10-14T11:58:02.500',
    account_action_seq: seq,
    global_action_seq: nextGlobal++,
    action_trace: { trx_id: `tx-${contract}-${seq}`, act: { account: contract, name, data: {} } }
  }
}

// rows(contract, [[name, block], ...]) -> rows with consecutive account_action_seq from `from`.
function rows (contract, list, from = 0) {
  return list.map(([name, blockNum], i) => row(contract, name, blockNum, from + i))
}

// A node whose state the test mutates between polls. history[contract] is the full list the
// node would serve right now; get_info reports `head`.
function fakeNode () {
  const node = { head: 100, history: {}, fetches: [] }
  for (const c of CONTRACTS) node.history[c] = []
  node.post = async (path, body) => {
    if (path === '/v1/chain/get_info') return { head_block_num: node.head }
    node.fetches.push([body.account_name, body.pos])
    return { actions: node.history[body.account_name].slice(body.pos, body.pos + body.offset) }
  }
  return node
}

function reader (node, current = 100) {
  const r = new GetActionsReader('http://history.test', CONTRACTS, 1)
  r.initialized = true
  r.seqPositions = Object.fromEntries(CONTRACTS.map(c => [c, 0]))
  r.currentBlockNumber = current
  r._post = node.post
  return r
}

// The watcher loop for one poll: nextBlock until "no new block". Returns what was handed over.
async function poll (r) {
  const out = []
  for (let guard = 0; guard < 100000; guard++) {
    const [b, , isNew] = await r.nextBlock()
    if (!isNew) return out
    out.push({ n: b.blockInfo.blockNumber, types: b.actions.map(a => a.type), actions: b.actions })
  }
  throw new Error('watcher loop never exited')
}

const withActions = blocks => blocks.filter(b => b.types.length > 0)

// The first get_actions for `contract` returns fail() instead (throw, or an error body).
function failFirstFetch (r, node, contract, fail) {
  let failed = false
  r._post = async (path, body) => {
    if (!failed && body.account_name === contract) {
      failed = true
      return fail()
    }
    return node.post(path, body)
  }
}

const boom = () => { throw new Error('boom') }

// Runs fn with console.error silenced: the reader logs the failures these tests provoke.
async function quietly (fn) {
  const err = console.error
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.error = err
  }
}

describe('GetActionsReader: whole blocks only', function () {
  this.timeout(5000)

  it('holds back a block the head snapshot does not cover, then hands it over whole', async () => {
    const node = fakeNode()
    const r = reader(node)
    // Poll 1: head 100; the token fetch already sees block 101, community fetch precedes it.
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['issue', 101], ['transfer', 101]])
    assert.deepStrictEqual(withActions(await poll(r)), [])
    assert.ok(r.currentBlockNumber <= 100, 'must not move past the snapshot head')

    // Poll 2: head 101, and the vote that landed in the same block is in history now.
    node.head = 101
    node.history['cambiatus.cm'] = rows('cambiatus.cm', [['verifyclaim', 101]])
    const got = withActions(await poll(r))
    assert.deepStrictEqual(got.map(b => b.n), [101])
    assert.deepStrictEqual(got[0].types, ['cambiatus.cm::verifyclaim', 'cambiatus.tk::issue', 'cambiatus.tk::transfer'])
  })

  it('does not hand over a block while a full page may end inside it', async () => {
    const node = fakeNode()
    node.head = 200
    const r = reader(node)
    // Page 1 (100 rows) ends inside block 105; block 105 continues on page 2. The rows of 105
    // on page 1 are not consumed; the next batch refetches them from seq 98 together with page 2.
    const page1 = Array.from({ length: 98 }, () => ['transfersale', 103]).concat([['a', 105], ['b', 105]])
    node.history['cambiatus.cm'] = rows('cambiatus.cm', page1.concat([['c', 105], ['d', 106]]))

    const got = []
    const page2Fetched = () => node.fetches.some(([c, pos]) => c === 'cambiatus.cm' && pos === 98)
    for (;;) {
      const [b, , isNew] = await r.nextBlock()
      if (!isNew) break
      if (b.actions.length === 0) continue
      if (b.blockInfo.blockNumber >= 105) assert.ok(page2Fetched(), 'block 105 handed over before it was refetched whole')
      got.push({ n: b.blockInfo.blockNumber, names: b.actions.map(a => a.payload.name) })
    }
    assert.deepStrictEqual(got.map(b => b.n), [103, 105, 106])
    assert.deepStrictEqual(got[1].names, ['a', 'b', 'c'])
  })

  it('emits a 250-action block of one contract once, without hanging', async () => {
    const node = fakeNode()
    node.head = 200
    node.history['cambiatus.cm'] = rows('cambiatus.cm', Array.from({ length: 250 }, () => ['mbrclaim', 101]))
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['transfer', 101]])
    const r = reader(node)
    const got = withActions(await poll(r))
    assert.deepStrictEqual(got.map(b => b.n), [101])
    assert.strictEqual(got[0].types.length, 251)
    assert.strictEqual(got[0].types[250], 'cambiatus.tk::transfer')
  })

  it('orders cm, then tk, then es, each by account_action_seq, whichever poll fetched them', async () => {
    const node = fakeNode()
    const r = reader(node)
    node.history['cambiatus.es'] = rows('cambiatus.es', [['deposit', 101]])
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['issue', 101], ['transfer', 101]])
    assert.deepStrictEqual(withActions(await poll(r)), [])
    node.head = 101
    node.history['cambiatus.cm'] = rows('cambiatus.cm', [['verifyclaim', 101], ['claimaction', 101]])
    const got = withActions(await poll(r))
    assert.deepStrictEqual(got.map(b => b.types), [[
      'cambiatus.cm::verifyclaim', 'cambiatus.cm::claimaction',
      'cambiatus.tk::issue', 'cambiatus.tk::transfer',
      'cambiatus.es::deposit'
    ]])
    const seqs = got[0].actions.map(a => a.payload.actionIndex)
    assert.deepStrictEqual(seqs, [0, 1, 0, 1, 0])
  })

  it('hands every action over exactly once with strictly increasing blocks (scripted polls)', async () => {
    const node = fakeNode()
    const r = reader(node)
    // A block's rows are in every contract's history once the head reaches it; rows past the
    // head may already be visible (the token fetch ran after a new block landed).
    const script = [
      { head: 101, add: { 'cambiatus.tk': [['issue', 101], ['transfer', 102]], 'cambiatus.cm': [['verifyclaim', 101]] } },
      { head: 102, add: { 'cambiatus.cm': [['claimaction', 102]] } },
      { head: 105, add: { 'cambiatus.es': [['deposit', 103]], 'cambiatus.tk': [['transfer', 104]], 'cambiatus.cm': [['x', 104], ['y', 105]] } },
      { head: 110, add: {} }
    ]
    const added = []
    const emitted = []
    const seen = []
    for (const step of script) {
      node.head = step.head
      for (const [c, list] of Object.entries(step.add)) {
        const extra = rows(c, list, node.history[c].length)
        node.history[c] = node.history[c].concat(extra)
        added.push(...extra.map(e => e.global_action_seq))
      }
      for (const b of withActions(await poll(r))) {
        seen.push(b.n)
        emitted.push(...b.actions.map(a => a.payload.globalSequence))
      }
    }
    const ascending = (a, b) => a - b
    assert.deepStrictEqual(emitted.sort(ascending), added.sort(ascending))
    assert.deepStrictEqual(seen, [...new Set(seen)].sort(ascending))
  })

  it('lets the watcher exit on an idle chain and moves to the head', async () => {
    const node = fakeNode()
    node.head = 150
    const r = reader(node)
    assert.deepStrictEqual(await poll(r), [])
    assert.strictEqual(r.currentBlockNumber, 150)
    const [b, rollback, isNew] = await r.nextBlock()
    assert.strictEqual(isNew, false)
    assert.strictEqual(rollback, false)
    assert.strictEqual(b.blockInfo.blockNumber, 150)
  })

  it('seekToBlock resets the emit limit', async () => {
    const node = fakeNode()
    node.head = 150
    const r = reader(node)
    node.history['cambiatus.cm'] = rows('cambiatus.cm', [['a', 120]])
    await poll(r)
    assert.strictEqual(r.emitLimit, 150)
    await r.seekToBlock(99)
    assert.strictEqual(r.emitLimit, 0)
  })

  it('keeps order and loses nothing when a later contract fetch fails mid-batch', async () => {
    const node = fakeNode()
    const r = reader(node)
    assert.deepStrictEqual(await poll(r), []) // a first, successful batch at head 100
    node.head = 200
    node.history['cambiatus.cm'] = rows('cambiatus.cm', [['late', 150]])
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['early', 120]])
    failFirstFetch(r, node, 'cambiatus.tk', boom)
    assert.deepStrictEqual(withActions(await quietly(() => poll(r))), [])
    assert.deepStrictEqual(withActions(await poll(r)).map(b => b.n), [120, 150])
  })

  it('does not take an error body for an empty page', async () => {
    const node = fakeNode()
    node.head = 200
    node.history['cambiatus.cm'] = rows('cambiatus.cm', [['late', 150]])
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['early', 120]])
    const r = reader(node)
    failFirstFetch(r, node, 'cambiatus.tk', () => ({ code: 503, message: 'busy' }))
    assert.deepStrictEqual(withActions(await quietly(() => poll(r))), [])
    assert.deepStrictEqual(withActions(await poll(r)).map(b => b.n), [120, 150])
  })

  it('takes a speculative row that lands one block later in its final block only', async () => {
    const node = fakeNode()
    const r = reader(node)
    // Poll 1: the node shows tk seq 0 in the pending block 101 (head is 100).
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['transfer', 101]])
    assert.deepStrictEqual(withActions(await poll(r)), [])
    assert.strictEqual(r.pendingActions.length, 0)
    assert.strictEqual(r.seqPositions['cambiatus.tk'], 0)
    // Poll 2: the same tx landed in block 102.
    node.head = 102
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['transfer', 102]])
    const got = withActions(await poll(r))
    assert.deepStrictEqual(got.map(b => b.n), [102])
    assert.strictEqual(got[0].types.length, 1)
  })

  it('never emits a speculative row whose tx did not land', async () => {
    const node = fakeNode()
    const r = reader(node)
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['transfer', 101]]) // tx A, provisional
    assert.deepStrictEqual(withActions(await poll(r)), [])
    node.head = 101
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['issue', 101]]) // tx B took seq 0
    const got = withActions(await poll(r))
    assert.deepStrictEqual(got.map(b => b.types), [['cambiatus.tk::issue']])
    assert.strictEqual(got[0].actions[0].payload.transactionId, 'tx-cambiatus.tk-0')
    assert.deepStrictEqual(withActions(await poll(r)), [])
  })

  it('ingests nothing when the second contract fetch fails after the first returned rows', async () => {
    const node = fakeNode()
    node.head = 101
    node.history['cambiatus.cm'] = rows('cambiatus.cm', [['verifyclaim', 101]])
    node.history['cambiatus.tk'] = rows('cambiatus.tk', [['issue', 101]])
    const r = reader(node)
    failFirstFetch(r, node, 'cambiatus.tk', boom)
    assert.deepStrictEqual(withActions(await quietly(() => poll(r))), [])
    assert.strictEqual(r.pendingActions.length, 0)
    assert.strictEqual(r.seqPositions['cambiatus.cm'], 0)
    const got = withActions(await poll(r))
    assert.deepStrictEqual(got.map(b => b.types), [['cambiatus.cm::verifyclaim', 'cambiatus.tk::issue']])
  })

  it('returns no new block on a network error and keeps what it had', async () => {
    const node = fakeNode()
    const r = reader(node)
    r._post = async () => boom()
    const [, , isNew] = await quietly(() => r.nextBlock())
    assert.strictEqual(isNew, false)
  })
})
