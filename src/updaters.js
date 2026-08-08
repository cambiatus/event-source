const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const { ResolveError } = require('./chain')
const { logError } = require('./logging')
const {
  createCommunity,
  updateCommunity,
  netlink,
  transferSale,
  upsertObjective,
  upsertAction,
  reward,
  verifyClaim,
  claimAction,
  upsertRole,
  assignRole
} = require('./updaters/community.js')
const {
  createToken,
  updateToken,
  transfer,
  issue,
  retire,
  setExpiry,
  initacc
} = require('./updaters/token.js')
const {
  regDeposit,
  release,
  refund,
  expire,
  sweep
} = require('./updaters/escrow.js')

// Persistent replay guard around every updater, keyed on the action's
// global_action_seq (set by GetActionsReader; unique across contracts). The INSERT
// atomically claims the seq inside the same block-level transaction demux opened for the
// updater's writes (`db` IS that transaction — see netlink/assignRole), so:
//   * ledger row + domain writes commit or roll back together;
//   * a reindex/seek over already-processed actions is a no-op here, regardless of the
//     per-updater guards (which stay on as the second layer — they also cover history
//     processed before this ledger existed, which has no rows in it);
//   * the in-memory seenGlobalSeqs Set in the reader remains the fast path; this is the
//     one that survives restarts.
// Caveat (pre-existing): updaters that open their own inner db.withTransaction commit on
// a separate connection, so their writes aren't atomic with the ledger row — exactly as
// they already weren't atomic with demux's _block_number_txid. The per-updater guards
// cover that window.
function ledgered (updater) {
  return async function (db, payload, blockInfo, context) {
    const seq = payload.globalSequence
    if (seq == null) return updater(db, payload, blockInfo, context)

    const claimed = await db.instance.oneOrNone(
      `INSERT INTO _processed_actions (global_seq) VALUES ($1)
       ON CONFLICT DO NOTHING
       RETURNING global_seq`,
      [seq]
    )
    if (claimed == null) {
      console.log(`Cambiatus >>> Skipping already-processed action (global_seq ${seq})`)
      return
    }

    try {
      return await updater(db, payload, blockInfo, context)
    } catch (e) {
      // A ResolveError means the updater could not establish the chain id it
      // must write (e.g. resolveClaimId with the chain read failing) and did
      // NOT write anything — every thrower must guarantee that, because the
      // block still commits below. Writing a serial-id row instead is how the
      // 2026-08 claim-id drift happened, so instead: un-claim the seq (same
      // block transaction — the ledger row we just inserted is deleted again),
      // page via Sentry, and let the block commit so the indexer keeps running.
      // Any other error type still propagates → rollback → process exit
      // (pre-existing behavior for genuinely unexpected failures).
      //
      // NOTE this is a real data loss until someone acts: demux's own block
      // cursor advances past this block regardless, so nothing reprocesses the
      // action on its own. Deleting the ledger row only makes it ELIGIBLE for a
      // later reindex of the range (scripts/reindex-runbook.md) — which is why
      // the Sentry page matters. The trade is deliberate: a missing claim row
      // can be reindexed, a wrong primary key cannot be undone.
      if (!(e instanceof ResolveError)) throw e
      await db.instance.none('DELETE FROM _processed_actions WHERE global_seq = $1', [seq])
      logError(
        `ResolveError: skipped action ${payload.data ? payload.data.action_id : ''} (global_seq ${seq}) — ` +
        'ledger row removed; needs a reindex of this block range to recover',
        e
      )
    }
  }
}

const updaters = [
  // ======== Community
  {
    actionType: `${config.blockchain.contract.community}::create`,
    updater: createCommunity
  },
  {
    actionType: `${config.blockchain.contract.community}::update`,
    updater: updateCommunity
  },
  {
    actionType: `${config.blockchain.contract.community}::netlink`,
    updater: netlink
  },
  {
    actionType: `${config.blockchain.contract.community}::upsertobjctv`,
    updater: upsertObjective
  },
  {
    actionType: `${config.blockchain.contract.community}::upsertaction`,
    updater: upsertAction
  },
  {
    actionType: `${config.blockchain.contract.community}::reward`,
    updater: reward
  },
  {
    actionType: `${config.blockchain.contract.community}::transfersale`,
    updater: transferSale
  },
  {
    actionType: `${config.blockchain.contract.community}::verifyclaim`,
    updater: verifyClaim
  },
  {
    actionType: `${config.blockchain.contract.community}::claimaction`,
    updater: claimAction
  },
  {
    actionType: `${config.blockchain.contract.community}::upsertrole`,
    updater: upsertRole
  },
  {
    actionType: `${config.blockchain.contract.community}::assignroles`,
    updater: assignRole
  },
  // ======== Token
  {
    actionType: `${config.blockchain.contract.token}::create`,
    updater: createToken
  },
  {
    actionType: `${config.blockchain.contract.token}::update`,
    updater: updateToken
  },
  {
    actionType: `${config.blockchain.contract.token}::transfer`,
    updater: transfer
  },
  {
    actionType: `${config.blockchain.contract.token}::issue`,
    updater: issue
  },
  {
    actionType: `${config.blockchain.contract.token}::retire`,
    updater: retire
  },
  {
    actionType: `${config.blockchain.contract.token}::setexpiry`,
    updater: setExpiry
  },
  {
    actionType: `${config.blockchain.contract.token}::initacc`,
    updater: initacc
  },
  // ======== Escrow
  {
    actionType: `${config.blockchain.contract.escrow}::regdeposit`,
    updater: regDeposit
  },
  {
    actionType: `${config.blockchain.contract.escrow}::release`,
    updater: release
  },
  {
    actionType: `${config.blockchain.contract.escrow}::refund`,
    updater: refund
  },
  {
    actionType: `${config.blockchain.contract.escrow}::expire`,
    updater: expire
  },
  {
    actionType: `${config.blockchain.contract.escrow}::sweep`,
    updater: sweep
  }
  // `setminimum` is deliberately not indexed: it is configuration (the `mindeposit`
  // per-symbol floor), not money movement — see the note in updaters/escrow.js.
]

// Every updater goes through the ledger — including ones added later.
module.exports = updaters.map(entry => ({ ...entry, updater: ledgered(entry.updater) }))
