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

// `more` from get_table_rows IS an honest "the walk did not reach the end of the
// index" signal. Do NOT read a row count below `limit` as proof of completeness:
// on nodeos v2.0.7 (what prod runs) the table walk is TIME-budgeted, so it stops
// long before `limit` and sets `more: true`.
//
// Measured against prod on 2026-08-07: the identical bounded `byaction` claim
// query returned 31, 35, 38, 51, 60, 67 then 79 rows on seven consecutive calls
// (the count tracks page-cache warmth, so it is not even deterministic), always
// with `more: true`; an unbounded read with `limit: 5000` returned 27 rows.
//
// So this guard is only safe for sets small enough that the node reliably walks
// them in one budget — it converts truncation into a throw. Anything that needs
// a COMPLETE set of a potentially large table must page until `more === false`
// instead (see resolveClaimId).
function assertComplete (res, table, context) {
  if (!res || !Array.isArray(res.rows)) throw new Error(`get_table_rows(${table}) returned no rows ${context}`)
  if (res.more) throw new Error(`get_table_rows(${table}) truncated ${context} (${res.rows.length} rows, more=true) — cannot page safely`)
}

// One page of the `claim` table read through the PRIMARY index, ascending from
// `lowerBound` (inclusive).
//
// The primary index is the only one we can page: `next_key` comes back as the
// next row's id and strictly advances, and the walk terminates with
// `more: false`. On a SECONDARY index (`byaction`) nodeos returns the secondary
// key instead — a query bounded to action 389 returns `next_key: 389` — so a
// truncated secondary read cannot be resumed at all. That is why claim
// resolution reads the primary index and filters client-side rather than asking
// the node for "the claims of action N".
async function claimPage (communityContract, lowerBound, limit) {
  const res = await post('/v1/chain/get_table_rows', {
    json: true,
    code: communityContract,
    scope: communityContract,
    table: 'claim',
    lower_bound: lowerBound,
    limit
  })
  if (!res || !Array.isArray(res.rows)) {
    throw new Error(`get_table_rows(claim) returned no rows from id ${lowerBound}`)
  }
  return res
}

// Resolve the real on-chain claim id for the claim a `claimaction` just created.
//
// `claimaction` does not carry the id: the contract generates it with
// get_available_id("claims"), a single global counter, so claim ids are globally
// ascending, never reused and never deleted (verifyclaim only mutates status).
// event-source processes actions in chain order, so the claim created by the
// action being processed is the FIRST claim on chain for this (action, claimer)
// with an id above every claim id already recorded — `afterId`, the DB's current
// max claim id.
//
// Reading forward from a watermark, rather than counting a pair's claims and
// taking the nth, is what makes this safe under truncation: a short page just
// costs another request instead of silently shrinking the set an ordinal indexes
// into. It is also robust to a gap: a claim skipped by an earlier ResolveError
// sits BELOW the watermark as soon as any later claim is recorded, so its id can
// never be handed to a different claim.
async function resolveClaimId (communityContract, actionId, maker, afterId, pageLimit = 1000, maxPages = 1000) {
  let lowerBound = Number(afterId) + 1

  for (let page = 0; page < maxPages; page++) {
    const res = await claimPage(communityContract, lowerBound, pageLimit)

    // Rows come back ascending by id, so the first match in the first page that
    // contains one is the smallest matching id above the watermark.
    const match = res.rows.find(r => Number(r.action_id) === Number(actionId) && r.claimer === maker)
    if (match) return Number(match.id)

    if (!res.more) break

    const next = Number(res.next_key)
    if (!Number.isFinite(next) || next <= lowerBound) {
      throw new Error(
        `resolveClaimId: get_table_rows(claim) reported more rows from id ${lowerBound} but ` +
        `next_key (${res.next_key}) did not advance — cannot page`
      )
    }
    lowerBound = next
  }

  throw new Error(
    `resolveClaimId: no chain claim for action ${actionId} / ${maker} above id ${afterId}`
  )
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
// on objective_id (index_position 2). Objectives hold a handful of actions
// (measured on prod 2026-08-07: objective 93 -> 2 rows, `more: false`), well
// inside one walk budget, so assertComplete's throw-on-`more` is the right
// guard here. If an objective ever grows past what the node walks in one
// budget this must move to primary-index paging like resolveClaimId — a
// secondary index cannot be resumed.
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
  assertComplete(res, 'action', `for objective ${objectiveId}`)
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
  assertComplete(res, 'objective', `for community ${communitySymbol}`)
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

module.exports = { resolveClaimId, resolveCreatedActionId, resolveCreatedObjectiveId, claimPage, ResolveError }
