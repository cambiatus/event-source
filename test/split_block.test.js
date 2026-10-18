/* eslint-env mocha */
// GetActionsReader can hand over one block in two parts: a 100-action batch that ends
// mid-block, or a block that one contract's fetch saw and another's didn't yet (prod lost
// a cambiatus.cm::transfersale this way on 2026-10-14, block 437155575). Both parts carry
// the same synthetic hash, so the handler must still apply the second part.
// No database: handleWithState is stubbed to record which blocks reach the updaters.
const assert = require('assert')
const { GetActionsHandler } = require('../src/GetActionsHandler')

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
})
