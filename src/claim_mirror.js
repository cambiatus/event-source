// Mirror of cambiatus.cm `mbrclaim` (one row per member + action) in
// member_action_claims. Applies the contract's own arithmetic; never decides anything.
// Callers pass the block-level `db` (demux's transaction), never a nested withTransaction.
const { toUTC } = require('./dates')

async function claimOpened (db, account, actionId, blockNumber) {
  await db.instance.none(
    `INSERT INTO member_action_claims (account, action_id, pending, approved, updated_block)
     VALUES ($1, $2, 1, 0, $3)
     ON CONFLICT (account, action_id) DO UPDATE
       SET pending = member_action_claims.pending + 1, updated_block = $3, updated_at = now()`,
    [account, Number(actionId), blockNumber]
  )
}

// The contract stores whole seconds (truncated). The column is timestamp(0), which ROUNDS,
// so a block at hh:mm:ss.500 would land one second late. Truncate before writing.
function wholeSeconds (date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
}

async function claimClosed (db, account, actionId, approved, blockTimestamp, blockNumber) {
  const rejectedAt = approved ? null : toUTC(wholeSeconds(blockTimestamp))
  await db.instance.none(
    `INSERT INTO member_action_claims (account, action_id, pending, approved, last_rejected_at, updated_block)
     VALUES ($1, $2, 0, $3, $4, $5)
     ON CONFLICT (account, action_id) DO UPDATE
       SET pending = GREATEST(member_action_claims.pending - 1, 0),
           approved = member_action_claims.approved + $3,
           last_rejected_at = COALESCE($4, member_action_claims.last_rejected_at),
           updated_block = $5, updated_at = now()`,
    [account, Number(actionId), approved ? 1 : 0, rejectedAt, blockNumber]
  )
}

async function rewarded (db, account, actionId, blockNumber) {
  await db.instance.none(
    `INSERT INTO member_action_claims (account, action_id, pending, approved, updated_block)
     VALUES ($1, $2, 0, 1, $3)
     ON CONFLICT (account, action_id) DO UPDATE
       SET approved = member_action_claims.approved + 1, updated_block = $3, updated_at = now()`,
    [account, Number(actionId), blockNumber]
  )
}

async function seeded (db, account, row, blockNumber) {
  const rejectedAt = Number(row.last_rejected_at) > 0 ? toUTC(new Date(Number(row.last_rejected_at) * 1000)) : null
  await db.instance.none(
    `INSERT INTO member_action_claims (account, action_id, pending, approved, last_rejected_at, updated_block)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account, action_id) DO UPDATE
       SET pending = $3, approved = $4, last_rejected_at = $5, updated_block = $6, updated_at = now()`,
    [account, Number(row.action_id), Number(row.pending), Number(row.approved), rejectedAt, blockNumber]
  )
}

module.exports = { claimOpened, claimClosed, rewarded, seeded }
