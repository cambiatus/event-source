/* eslint-env mocha */
// GetActionsReader can hand over one block in two parts: a 100-action batch that ends
// mid-block, or a block that one contract's fetch saw and another's didn't yet (prod lost
// a cambiatus.cm::transfersale this way on 2026-10-14, block 437155575). Both parts carry
// the same synthetic hash, so the handler must still apply the second part.
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
    h.handled.push(h.pending.actions.map(a => a.type))
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

  // polls: one entry per _loadNextBatch, mapping contract -> the rows its fetch returns.
  function reader (polls) {
    const r = new GetActionsReader('http://history.test', ['cambiatus.cm', 'cambiatus.tk'], 1)
    r.initialized = true
    r.seqPositions = { 'cambiatus.cm': 0, 'cambiatus.tk': 0 }
    r.currentBlockNumber = 100
    let poll = -1
    r._post = async (path, body) => {
      if (path === '/v1/chain/get_info') return { head_block_num: 200 }
      if (body.account_name === 'cambiatus.cm') poll++
      return { actions: (polls[poll] || {})[body.account_name] || [] }
    }
    return r
  }

  async function run (polls, steps) {
    const r = reader(polls)
    const h = handler()
    for (let i = 0; i < steps; i++) {
      const [b] = await r.nextBlock()
      await h.deliver(b)
    }
    return h.handled
  }

  it('applies the vote that arrives on the next poll', async () => {
    const handled = await run([
      { 'cambiatus.tk': [row('cambiatus.tk', 'issue', 101, 0, 2), row('cambiatus.tk', 'transfer', 101, 1, 3)] },
      { 'cambiatus.cm': [row('cambiatus.cm', 'verifyclaim', 101, 0, 1)] }
    ], 2)
    assert.deepStrictEqual(handled, [['cambiatus.tk::issue', 'cambiatus.tk::transfer'], ['cambiatus.cm::verifyclaim']])
  })

  it('applies the vote when the token fetch already saw a later block', async () => {
    const handled = await run([
      { 'cambiatus.tk': [row('cambiatus.tk', 'issue', 101, 0, 2), row('cambiatus.tk', 'transfer', 102, 1, 4)] },
      { 'cambiatus.cm': [row('cambiatus.cm', 'verifyclaim', 101, 0, 1)] }
    ], 3)
    assert.deepStrictEqual(handled, [['cambiatus.tk::issue'], ['cambiatus.tk::transfer'], ['cambiatus.cm::verifyclaim']])
  })
})
