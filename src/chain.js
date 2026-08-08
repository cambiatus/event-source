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
// with `more: true`; an unbounded read with `limit: 5000` returned 27 rows. The
// 400-row `action` table takes 5 calls to read in full.
//
// So a single call is never proof of a complete set, at any table size. Read
// every table that a resolver depends on through this pager, which follows
// `next_key` until the node says `more: false`.
//
// PRIMARY index only. On a secondary index nodeos returns the secondary key as
// `next_key` (a query bounded to action 389 returns `next_key: 389`), so it does
// not advance and a truncated secondary read cannot be resumed at all. That is
// why the callers below scan a table and filter client-side rather than asking
// the node for "the rows matching key K".
// One get_table_rows call, retried on a transient failure.
//
// Retrying matters more than it looks: the resolvers no longer fall back to a DB
// serial, so a read that fails is a create the indexer skips until someone
// reindexes. A dropped connection or a node hiccup should not cost that. Measured
// against prod 2026-08-08, roughly 2 in 100 calls came back without a `rows`
// array while paging the action table. Reads are pure, and every caller runs
// before its first write, so a retry is free of side effects.
//
// The node's own message is carried into the final error — with Sentry not
// running, the log line is the only diagnostic anyone gets.
async function getTableRows (body, what, attempts = 3) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await post('/v1/chain/get_table_rows', body)
      if (res && Array.isArray(res.rows)) return res
      last = `node replied without a rows array: ${JSON.stringify(res).slice(0, 300)}`
    } catch (e) {
      last = e.message
    }
    if (attempt < attempts) await new Promise(r => setTimeout(r, 250 * attempt))
  }
  throw new Error(`get_table_rows for ${what} failed after ${attempts} attempts — ${last}`)
}

async function pageAllRows (params, what) {
  const rows = []
  let lowerBound = 0

  for (let page = 0; page < 1000; page++) {
    const res = await getTableRows({
      json: true,
      limit: 1000,
      ...params,
      lower_bound: lowerBound
    }, what)
    rows.push(...res.rows)

    if (!res.more) return rows

    const next = Number(res.next_key)
    if (!Number.isFinite(next) || next <= lowerBound) {
      throw new Error(
        `paging ${what}: next_key (${res.next_key}) did not advance past ${lowerBound}`
      )
    }
    lowerBound = next
  }

  throw new Error(`paging ${what} did not terminate`)
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
  return getTableRows({
    json: true,
    code: communityContract,
    scope: communityContract,
    table: 'claim',
    lower_bound: lowerBound,
    limit
  }, `claims from id ${lowerBound}`)
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

// Every on-chain action belonging to one objective.
//
// This reads the WHOLE `action` table through the primary index and filters
// client-side, rather than using the `byobjective` secondary index. The
// secondary index would look cheaper, but it truncates on the same time budget
// as everything else and cannot be resumed (see pageAllRows), so a short read
// silently looks like "this objective has fewer actions than it does" — and the
// caller turns a missing id into the id of the action being created. The whole
// table is 400 rows / 5 calls on prod (2026-08-08), and this runs only on the
// create path, so scanning it is the cheaper mistake.
async function actionsForObjective (communityContract, objectiveId) {
  const all = await pageAllRows(
    { code: communityContract, scope: communityContract, table: 'action' },
    `actions of objective ${objectiveId}`
  )
  return all.filter(a => Number(a.objective_id) === Number(objectiveId))
}

// Every on-chain objective of one community. Objectives live in a per-community
// scope (the raw symbol value) under the primary index, so paging that scope
// returns exactly this community's objectives and nothing else.
async function objectivesForCommunity (communityContract, communitySymbol) {
  return pageAllRows(
    { code: communityContract, scope: symbolRaw(communitySymbol), table: 'objective' },
    `objectives of community ${communitySymbol}`
  )
}

// Resolve the real on-chain id of the action being CREATED (upsertaction with
// action_id = 0 — the contract generates the id and the payload doesn't carry
// it). `knownIds` is the set of action ids already in the DB for this
// objective. Blocks are processed in order, so the earliest chain id we don't
// have yet is this create: the created action = the SMALLEST chain id not in
// `knownIds`. Throws if every chain id is already known (chain/DB out of sync —
// e.g. the create hasn't reached the node we query yet); the caller turns that
// into a ResolveError and skips the action rather than inventing an id.
async function resolveCreatedActionId (communityContract, objectiveId, knownIds) {
  const chainIds = (await actionsForObjective(communityContract, objectiveId))
    .map(a => Number(a.id))
    .sort((a, b) => a - b)

  const created = chainIds.find(id => !knownIds.has(id))
  if (created === undefined) {
    throw new Error(
      `resolveCreatedActionId: all ${chainIds.length} chain actions for objective ${objectiveId} ` +
      'are already in the DB, nothing left to create.'
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
      'are already in the DB, nothing left to create.'
    )
  }
  return created
}

module.exports = { resolveClaimId, resolveCreatedActionId, resolveCreatedObjectiveId, claimPage, ResolveError }
