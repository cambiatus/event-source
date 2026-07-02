const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
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

    return updater(db, payload, blockInfo, context)
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
  }
]

// Every updater goes through the ledger — including ones added later.
module.exports = updaters.map(entry => ({ ...entry, updater: ledgered(entry.updater) }))
