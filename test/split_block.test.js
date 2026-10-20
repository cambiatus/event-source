/* eslint-env mocha */
// GetActionsReader used to hand over one block in two parts: a 100-action batch that ends
// mid-block, or a block that one contract's fetch saw and another's didn't yet (prod lost
// a cambiatus.cm::transfersale this way on 2026-10-14, block 437155575). Both parts carry
// the same synthetic hash, so the handler must still apply the second part. The reader now
// holds a block back until it is whole (see reader_whole_blocks.test.js); the handler keeps
// this safety net.
// No database: handleWithState is stubbed to record which blocks reach the updaters.
const assert = require('assert')
const { GetActionsHandler } = require('../src/GetActionsHandler')
const { GetActionsReader } = require('../src/GetActionsReader')

function block (blockNumber, types) {
  return {
    blockInfo: {
      blockNumber,
      blockHash: `synthetic-${blockNumber}`,
      previousBlockHash: `synthetic-${blockNumber - 1}`,
      timestamp: new Date('2026-10-14T11:58:02Z')
    },
    actions: types.map(type => ({ type, payload: {} }))
  }
}

function handler () {
  const h = new GetActionsHandler([], [], {}, 'public')
  h.handled = []
  // Already past the first block, so refreshIndexState and the resume seek don't run.
  h.lastProcessedBlockNumber = 100
  h.lastProcessedBlockHash = 'synthetic-100'
  h.handleWithState = async () => {
    // Like the real handler, an empty block never reaches the updaters.
    if (h.pending.actions.length > 0) h.handled.push(h.pending.actions.map(a => a.type))
    h.lastProcessedBlockNumber = h.pending.blockInfo.blockNumber
    h.lastProcessedBlockHash = h.pending.blockInfo.blockHash
  }
  h.deliver = b => { h.pending = b; return h.handleBlock(b, false, false) }
  return h
}

describe('GetActionsHandler: a block delivered in two parts', () => {
  it('applies both parts', async () => {
    const h = handler()
    await h.deliver(block(101, ['cambiatus.tk::transfer']))
    await h.deliver(block(101, ['cambiatus.cm::transfersale']))
    assert.deepStrictEqual(h.handled, [['cambiatus.tk::transfer'], ['cambiatus.cm::transfersale']])
  })

  it('still skips an empty re-delivery of the last block', async () => {
    const h = handler()
    await h.deliver(block(101, ['cambiatus.cm::claimaction']))
    const result = await h.deliver(block(101, []))
    assert.deepStrictEqual(result, [false, 0])
    assert.deepStrictEqual(h.handled, [['cambiatus.cm::claimaction']])
  })

  it('applies a part that arrives after a later block', async () => {
    const h = handler()
    await h.deliver(block(101, ['cambiatus.tk::issue']))
    await h.deliver(block(102, ['cambiatus.tk::transfer']))
    await h.deliver(block(101, ['cambiatus.cm::verifyclaim']))
    assert.deepStrictEqual(h.handled, [['cambiatus.tk::issue'], ['cambiatus.tk::transfer'], ['cambiatus.cm::verifyclaim']])
  })
})

// The whole path, reader included. Contracts are polled one after another, so a block that
// lands between the cambiatus.cm fetch and the cambiatus.tk fetch reaches the reader as its
// token part first and its community part on the next poll. Prod lost two approving votes
// this way (blocks 432887717 and 433192353, 2026-09-19 and 09-21): the reward's
// issue/transfer were indexed, the cambiatus.cm::verifyclaim was not.
describe('GetActionsReader + GetActionsHandler: a block that lands between two contract fetches', () => {
  // One get_actions row, as the history API returns it.
  function row (contract, name, blockNum, seq, globalSeq) {
    return {
      block_num: blockNum,
      block_time: '2026-09-21T13:31:11.500',
      account_action_seq: seq,
      global_action_seq: globalSeq,
      action_trace: { trx_id: `tx-${globalSeq}`, act: { account: contract, name, data: {} } }
    }
  }

  // polls: one entry per _loadNextBatch, mapping contract -> the rows its fetch returns (a
  // fetch always starts at the contract's first unconsumed seq, so rows above the limit repeat).
  // heads: the head get_info reports at the start of each batch (the reader's snapshot).
  function reader (polls, heads) {
    const r = new GetActionsReader('http://history.test', ['cambiatus.cm', 'cambiatus.tk'], 1)
    r.initialized = true
    r.seqPositions = { 'cambiatus.cm': 0, 'cambiatus.tk': 0 }
    r.currentBlockNumber = 100
    r._headRefreshedAt = Date.now() // nextBlock's own head read stays cached; only batches call get_info
    r.headBlockNumber = 100
    let poll = -1
    r._post = async (path, body) => {
      if (path === '/v1/chain/get_info') {
        poll++
        return { head_block_num: heads[Math.min(poll, heads.length - 1)] }
      }
      return { actions: (polls[poll] || {})[body.account_name] || [] }
    }
    return r
  }

  // The watcher loop, once per poll: nextBlock until it reports no new block.
  async function run (polls, heads) {
    const r = reader(polls, heads)
    const h = handler()
    for (let i = 0; i < polls.length; i++) {
      for (;;) {
        const [b, , isNew] = await r.nextBlock()
        if (!isNew) break
        await h.deliver(b)
      }
    }
    return h.handled
  }

  it('hands the block over once, whole, when the vote arrives on the next poll', async () => {
    const handled = await run([
      { 'cambiatus.tk': [row('cambiatus.tk', 'issue', 101, 0, 2), row('cambiatus.tk', 'transfer', 101, 1, 3)] },
      {
        'cambiatus.cm': [row('cambiatus.cm', 'verifyclaim', 101, 0, 1)],
        'cambiatus.tk': [row('cambiatus.tk', 'issue', 101, 0, 2), row('cambiatus.tk', 'transfer', 101, 1, 3)]
      }
    ], [100, 101])
    assert.deepStrictEqual(handled, [['cambiatus.cm::verifyclaim', 'cambiatus.tk::issue', 'cambiatus.tk::transfer']])
  })

  it('holds back only the blocks the snapshot does not cover', async () => {
    const handled = await run([
      { 'cambiatus.tk': [row('cambiatus.tk', 'issue', 101, 0, 2), row('cambiatus.tk', 'transfer', 102, 1, 4)] },
      {
        'cambiatus.cm': [row('cambiatus.cm', 'verifyclaim', 101, 0, 1)],
        'cambiatus.tk': [row('cambiatus.tk', 'issue', 101, 0, 2), row('cambiatus.tk', 'transfer', 102, 1, 4)]
      }
    ], [100, 102])
    assert.deepStrictEqual(handled, [['cambiatus.cm::verifyclaim', 'cambiatus.tk::issue'], ['cambiatus.tk::transfer']])
  })
})
