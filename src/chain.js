const http = require('http')
const https = require('https')
const { URL } = require('url')
const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)

// Minimal POST to the EOS node (same transport style as GetActionsReader).
function post (path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.blockchain.url)
    const data = JSON.stringify(body)
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (e) { reject(e) }
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Thrown when a chain id cannot be resolved. Distinct type so the `ledgered`
// wrapper (updaters.js) can tell "skip this action and leave it unprocessed"
// apart from a bug that should still crash the indexer.
class ResolveError extends Error {}

// Do NOT trust `res.more` from get_table_rows on a bounded secondary-index
// query: on nodeos v2.0.x (prod runs v2.0.7) `more` is true whenever the index
// iterator stopped anywhere short of end-of-index — i.e. whenever ANY row with
// a higher key exists — even though the bounds filtered correctly (verified
// against prod 2026-08-05: a query bounded to action 389 returned only that
// action's 22 rows, yet `more: true`). Treating it as truncation made every
// resolve throw, and the caller's serial fallback then wrote drifted claim ids
// (the live claim-id drift this module exists to prevent). The only reliable
// truncation signal on these nodeos versions is hitting the requested limit.
function assertComplete (res, limit, table, context) {
  if (!res || !Array.isArray(res.rows)) throw new Error(`get_table_rows(${table}) returned no rows ${context}`)
  if (res.rows.length >= limit) throw new Error(`too many ${table} rows ${context} (${res.rows.length} >= limit ${limit}) to page safely`)
}

// Fetch every on-chain claim for a single action via the `byaction` secondary
// index (index_position 2). An action realistically has far fewer than the
// limit; if the limit is ever hit, throw so we never compute an ordinal off a
// truncated set (fail-safe — the claim is skipped and left unprocessed for a
// later pass; see claimAction). `limit` is a parameter only so acceptance
// tests can exercise the truncation guard without writing 5000 chain rows.
async function claimsForAction (communityContract, actionId, limit = 5000) {
  const res = await post('/v1/chain/get_table_rows', {
    json: true,
    code: communityContract,
    scope: communityContract,
    table: 'claim',
    index_position: 2,
    key_type: 'i64',
    lower_bound: actionId,
    upper_bound: actionId,
    limit
  })
  assertComplete(res, limit, 'claim', `for action ${actionId}`)
  return res.rows
}

// Resolve the real on-chain claim id for the claim being processed.
//
// The chain assigns claim ids sequentially (get_available_id) and NEVER deletes a
// claim (verifyclaim only mutates status), and the `claimaction` payload does not
// carry the generated id. So for a given (action, claimer), the nth claim by
// ascending id is the nth `claimaction` event-source processes for that pair — in
// live AND replay. `ordinal` is the count of claims already recorded in the DB for
// this pair (0-based index of the new one). Throws if the chain doesn't have that
// many claims yet, so a transient/ordering problem skips the claim (left
// unprocessed for a later pass — see claimAction) instead of writing a wrong id.
async function resolveClaimId (communityContract, actionId, maker, ordinal) {
  const mine = (await claimsForAction(communityContract, actionId))
    .filter(c => c.claimer === maker)
    .sort((a, b) => Number(a.id) - Number(b.id))

  const claim = mine[ordinal]
  if (!claim) {
    throw new Error(
      `resolveClaimId: chain has ${mine.length} claims for action ${actionId} / ${maker}, ` +
      `need index ${ordinal}.`
    )
  }
  return Number(claim.id)
}

// Convert a "precision,CODE" symbol string (the format used across this repo,
// e.g. "0,MUDA" — see eos_helper.getSymbolFromAsset) to the raw uint64 an EOS
// node expects as a table scope, as a decimal string. Layout is the EOS symbol
// encoding: precision in the low byte, then one code character per byte.
// BigInt because a 7-character code occupies bits past 2^53.
function symbolRaw (symbolString) {
  const [precision, code] = symbolString.split(',')
  let raw = BigInt(precision)
  for (let i = 0; i < code.length; i++) {
    raw |= BigInt(code.charCodeAt(i)) << BigInt(8 * (i + 1))
  }
  return raw.toString()
}

// Fetch every on-chain action for a single objective via the secondary index
// on objective_id (index_position 2). An objective realistically has far fewer
// actions than the limit; if the limit is ever hit, throw so we never pick an
// id off a truncated set (same fail-safe as claimsForAction — and the same
// warning applies: `res.more` is NOT a truncation signal on nodeos v2.0.x).
async function actionsForObjective (communityContract, objectiveId) {
  const res = await post('/v1/chain/get_table_rows', {
    json: true,
    code: communityContract,
    scope: communityContract,
    table: 'action',
    index_position: 2,
    key_type: 'i64',
    lower_bound: objectiveId,
    upper_bound: objectiveId,
    limit: 5000
  })
  assertComplete(res, 5000, 'action', `for objective ${objectiveId}`)
  return res.rows
}

// Fetch every on-chain objective for a single community. Objectives live in a
// per-community scope (the raw symbol value) under the primary index, so a
// plain scan returns exactly this community's objectives. Same truncation
// guard as above.
async function objectivesForCommunity (communityContract, communitySymbol) {
  const res = await post('/v1/chain/get_table_rows', {
    json: true,
    code: communityContract,
    scope: symbolRaw(communitySymbol),
    table: 'objective',
    limit: 2000
  })
  assertComplete(res, 2000, 'objective', `for community ${communitySymbol}`)
  return res.rows
}

// Resolve the real on-chain id of the action being CREATED (upsertaction with
// action_id = 0 — the contract generates the id and the payload doesn't carry
// it). `knownIds` is the set of action ids already in the DB for this
// objective. Blocks are processed in order, so the earliest chain id we don't
// have yet is this create: the created action = the SMALLEST chain id not in
// `knownIds`. Throws if every chain id is already known (chain/DB out of sync
// — e.g. the create hasn't reached the node we query yet), so the block
// retries instead of writing a wrong id.
async function resolveCreatedActionId (communityContract, objectiveId, knownIds) {
  const chainIds = (await actionsForObjective(communityContract, objectiveId))
    .map(a => Number(a.id))
    .sort((a, b) => a - b)

  const created = chainIds.find(id => !knownIds.has(id))
  if (created === undefined) {
    throw new Error(
      `resolveCreatedActionId: all ${chainIds.length} chain actions for objective ${objectiveId} ` +
      'are already in the DB, nothing left to create. Retrying block.'
    )
  }
  return created
}

// Same idea for objectives: the created objective = the SMALLEST chain id (in
// this community's scope) not yet in the DB. See resolveCreatedActionId for
// the rationale and failure semantics.
async function resolveCreatedObjectiveId (communityContract, communitySymbol, knownIds) {
  const chainIds = (await objectivesForCommunity(communityContract, communitySymbol))
    .map(o => Number(o.id))
    .sort((a, b) => a - b)

  const created = chainIds.find(id => !knownIds.has(id))
  if (created === undefined) {
    throw new Error(
      `resolveCreatedObjectiveId: all ${chainIds.length} chain objectives for community ${communitySymbol} ` +
      'are already in the DB, nothing left to create. Retrying block.'
    )
  }
  return created
}

module.exports = { resolveClaimId, resolveCreatedActionId, resolveCreatedObjectiveId, claimsForAction, ResolveError }
