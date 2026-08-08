const { parseToken, getSymbolFromAsset } = require('../eos_helper')
const { toUTC } = require('../dates')

// Mirrors the `cambiatus.es` escrow contract into `escrow_deposits`.
//
// The contract erases a deposit row when it closes, so table state alone can't tell you
// what happened — history lives in these actions. That is why deposits are addressed by
// `order_ref` and not by a row id: `release`/`refund`/`expire` name the order directly,
// so each action is attributable on its own, with no mirrored state to rebuild on a
// reindex.
//
// Every updater here is wrapped by `ledgered()` in updaters.js, which claims the action's
// global_seq inside the block transaction. The per-updater guards below are the second
// layer, keyed on the same per-action identity (payload.globalSequence), covering history
// processed before that ledger existed or after it is truncated.
//
// Deliberately NOT indexed: `setminimum`. It writes the `mindeposit` config table (the
// per-symbol deposit floor), which is configuration, not money movement — nothing the
// reconciler checks depends on it, and mirroring config would add replay-safety surface
// for no benefit. Consumers that validate a deposit amount (the P3.2/P3.3 buy flow)
// read the `mindeposit` row from chain instead.

async function regDeposit (db, payload, blockInfo, context) {
  console.log('Cambiatus >>> New Escrow Deposit')

  const [amount] = parseToken(payload.data.quantity)
  const communityId = getSymbolFromAsset(payload.data.quantity)

  // Timestamps come from the block, not from the clock, so re-indexing an action
  // reproduces the same row instead of a differently-stamped one.
  //
  // The conflict target is explicit and per-action: created_global_seq is the action's
  // global_action_seq (unique across contracts, the same key the _processed_actions
  // ledger claims), backed by a unique index. A replayed regdeposit collapses onto the
  // row it already wrote — even when that row has since closed, which the partial
  // open-order_ref index cannot catch — while a legitimate second deposit on a reused
  // ref (regdeposit → release → regdeposit in one transaction) has a different seq and
  // lands normally. Keying on (created_tx, order_ref) instead would silently drop that
  // second deposit: the pair repeats within the shared transaction.
  //
  // The NOT EXISTS preserves the old blanket ON CONFLICT's one useful behavior:
  // skipping the insert when an open row already exists for the ref, instead of
  // turning the partial-index violation into an updater crash. It is what covers rows
  // indexed before created_global_seq existed (their seq is NULL, so the conflict
  // target can't match them) — but only while they are still open. A replay against a
  // legacy CLOSED row still can't be told apart from a new deposit locally; such rows
  // must have created_global_seq backfilled (or be rebuilt) before a full reindex.
  await db.instance.none(
    `INSERT INTO escrow_deposits
       (order_ref, community_id, buyer_id, seller_id, arbiter_id, amount, status,
        created_tx, created_block, created_at, created_global_seq,
        inserted_at, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $9, $9
     WHERE NOT EXISTS (
       SELECT 1 FROM escrow_deposits WHERE order_ref = $1 AND status = 'open'
     )
     ON CONFLICT (created_global_seq) DO NOTHING`,
    [
      payload.data.order_ref,
      communityId,
      payload.data.buyer,
      payload.data.seller,
      payload.data.arbiter,
      amount,
      payload.transactionId,
      blockInfo.blockNumber,
      toUTC(blockInfo.timestamp),
      payload.globalSequence
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

// The backstop close: anyone can fire `expire` once a deposit is older than
// ESCROW_EXPIRY_SECONDS, and it always pays the buyer. Indexed as its own status
// (`expired`, not `refunded`) so "the counterparty went silent and the backstop
// fired" stays distinguishable from "the seller refunded" — the P3.5 escalation
// work needs to tell them apart.
async function expire (db, payload, blockInfo, context) {
  console.log('Cambiatus >>> Escrow Expire')
  return closeDeposit(db, payload, blockInfo, 'expired')
}

// Closes the deposit this action actually closed. `status = 'open'` alone is not enough:
// it matches whichever row is CURRENTLY open, so a replayed close (after a ledger
// truncation or DB restore) would close a NEWER deposit on the reused ref with the old
// action's closed_tx/closed_by. Bounding by `created_block <= this action's block` keeps
// the match to deposits that already existed when the close happened — a later deposit
// on the same ref is untouched, and a replay against the original (now closed) row finds
// no open match, making the replay a no-op. No match means we never saw the regdeposit
// (or already closed it): skip and log rather than throwing, so one unindexed deposit
// can't wedge the block.
//
// closed_by: `release`/`refund` carry a meaningful settler — the buyer, seller or arbiter
// signed the action, and the contract required that signature. `expire` carries none: it
// is permissionless (no require_auth, so the authorization array can even be empty) and
// whoever fires it gains nothing, because the contract always pays the BUYER. So an
// expired close records the buyer, taken from the row being closed rather than the
// payload: the one account every expire provably pays, which is also the answer
// reconciliation needs for "where did the money go".
async function closeDeposit (db, payload, blockInfo, status) {
  const orderRef = payload.data.order_ref
  const closedBy = status === 'expired' ? null : payload.authorization[0].actor

  const closed = await db.instance.oneOrNone(
    `UPDATE escrow_deposits
        SET status = $1, closed_tx = $2, closed_block = $3, closed_at = $4,
            closed_by = COALESCE($5, buyer_id), updated_at = $4
      WHERE order_ref = $6 AND status = 'open' AND created_block <= $7
      RETURNING id`,
    [
      status,
      payload.transactionId,
      blockInfo.blockNumber,
      toUTC(blockInfo.timestamp),
      closedBy,
      orderRef,
      blockInfo.blockNumber
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
  expire,
  sweep
}
