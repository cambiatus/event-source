const { parseToken, getSymbolFromAsset } = require('../eos_helper')

// Mirrors the `cambiatus.es` escrow contract into `escrow_deposits`.
//
// The contract erases a deposit row when it closes, so table state alone can't tell you
// what happened — history lives in these actions. That is why deposits are addressed by
// `order_ref` and not by a row id: `release`/`refund` name the order directly, so each
// action is attributable on its own, with no mirrored state to rebuild on a reindex.
//
// Every updater here is wrapped by `ledgered()` in updaters.js, which claims the action's
// global_seq inside the block transaction. The ON CONFLICT / `status = 'open'` guards are
// the second layer, covering history processed before that ledger existed.

async function regDeposit (db, payload, blockInfo, context) {
  console.log('Cambiatus >>> New Escrow Deposit')

  const [amount] = parseToken(payload.data.quantity)
  const communityId = getSymbolFromAsset(payload.data.quantity)

  // Timestamps come from the block, not from the clock, so re-indexing an action
  // reproduces the same row instead of a differently-stamped one.
  await db.instance.none(
    `INSERT INTO escrow_deposits
       (order_ref, community_id, buyer_id, seller_id, arbiter_id, amount, status,
        created_tx, created_block, created_at, inserted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $9, $9)
     ON CONFLICT DO NOTHING`,
    [
      payload.data.order_ref,
      communityId,
      payload.data.buyer,
      payload.data.seller,
      payload.data.arbiter,
      amount,
      payload.transactionId,
      blockInfo.blockNumber,
      blockInfo.timestamp
    ]
  )
}

async function release (db, payload, blockInfo, context) {
  console.log('Cambiatus >>> Escrow Release')
  return closeDeposit(db, payload, blockInfo, 'released')
}

async function refund (db, payload, blockInfo, context) {
  console.log('Cambiatus >>> Escrow Refund')
  return closeDeposit(db, payload, blockInfo, 'refunded')
}

// Closes the OPEN deposit for this order_ref. Scoping the UPDATE to `status = 'open'`
// makes a replay a no-op and stops a later deposit on a reused ref from being closed by
// an old action. No open row means we never saw the regdeposit (or already closed it):
// skip and log rather than throwing, so one unindexed deposit can't wedge the block.
async function closeDeposit (db, payload, blockInfo, status) {
  const orderRef = payload.data.order_ref

  const closed = await db.instance.oneOrNone(
    `UPDATE escrow_deposits
        SET status = $1, closed_tx = $2, closed_block = $3, closed_at = $4,
            closed_by = $5, updated_at = $4
      WHERE order_ref = $6 AND status = 'open'
      RETURNING id`,
    [
      status,
      payload.transactionId,
      blockInfo.blockNumber,
      blockInfo.timestamp,
      payload.authorization[0].actor,
      orderRef
    ]
  )

  if (closed == null) {
    console.warn(
      `Cambiatus >>> Escrow ${status}: no open deposit for order_ref ${orderRef} ` +
      `(tx ${payload.transactionId}) — skipping`
    )
  }
}

// Sweeps only ever move funds that back no open deposit, so no deposit row changes and
// there is nothing to mirror. The money movement itself is already recorded: the inline
// cambiatus.tk::transfer it emits is indexed by the token updater into `transfers`.
async function sweep (db, payload, blockInfo, context) {
  console.log(
    `Cambiatus >>> Escrow Sweep of ${payload.data.symbol} to ${payload.data.to} ` +
    `(tx ${payload.transactionId})`
  )
}

module.exports = {
  regDeposit,
  release,
  refund,
  sweep
}
