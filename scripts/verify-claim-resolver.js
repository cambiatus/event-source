// Acceptance check for chain.js/resolveClaimId against a REAL node.
//
// Run read-only against prod:
//   NODE_ENV=prod node scripts/verify-claim-resolver.js
// or against a local chain:
//   NODE_ENV=local node scripts/verify-claim-resolver.js
//
// It snapshots the tail of the on-chain `claim` table by paging the primary
// index, derives the answer resolveClaimId MUST give for a set of
// (action, claimer, watermark) probes, and compares. Probes deliberately
// include ones whose match sits hundreds of ids above the watermark, so the
// resolver has to walk several truncated pages to reach it — that is the case
// nodeos v2.0.7's time-budgeted walk broke, and the reason this file exists.

const config = require(`../src/config/${process.env.NODE_ENV || 'dev'}`)
const { resolveClaimId, claimPage } = require('../src/chain')

const CONTRACT = config.blockchain.contract.community
const SNAPSHOT_FROM = Number(process.env.SNAPSHOT_FROM || 0)

async function snapshot () {
  const rows = []
  let lowerBound = SNAPSHOT_FROM
  for (let page = 0; page < 5000; page++) {
    const res = await claimPage(CONTRACT, lowerBound, 1000)
    rows.push(...res.rows)
    if (!res.more) return rows
    const next = Number(res.next_key)
    if (!Number.isFinite(next) || next <= lowerBound) throw new Error('next_key did not advance')
    lowerBound = next
  }
  throw new Error('snapshot did not terminate')
}

// The contract-truthful answer: smallest claim id above `afterId` for the pair.
function expected (rows, actionId, maker, afterId) {
  const hits = rows
    .filter(r => Number(r.action_id) === Number(actionId) && r.claimer === maker && Number(r.id) > afterId)
    .map(r => Number(r.id))
    .sort((a, b) => a - b)
  return hits.length ? hits[0] : null
}

async function main () {
  console.log(`node: ${config.blockchain.url}  contract: ${CONTRACT}`)
  const rows = await snapshot()
  const ids = rows.map(r => Number(r.id)).sort((a, b) => a - b)
  console.log(`snapshot: ${rows.length} claims, ids ${ids[0]}..${ids[ids.length - 1]}`)

  // Build probes: for every pair with >= 2 claims, probe just below its FIRST
  // claim (long walk) and just below its LAST claim (the live case).
  const byPair = new Map()
  for (const r of rows) {
    const key = `${r.action_id}|${r.claimer}`
    if (!byPair.has(key)) byPair.set(key, [])
    byPair.get(key).push(Number(r.id))
  }

  const probes = []
  for (const [key, pairIds] of byPair) {
    const [actionId, maker] = key.split('|')
    pairIds.sort((a, b) => a - b)
    probes.push({ actionId, maker, afterId: pairIds[0] - 1, kind: 'first-claim (long walk)' })
    if (pairIds.length > 1) {
      probes.push({ actionId, maker, afterId: pairIds[pairIds.length - 1] - 1, kind: 'latest-claim (live case)' })
    }
  }

  let pass = 0
  const failures = []
  for (const p of probes) {
    const want = expected(rows, p.actionId, p.maker, p.afterId)
    let got
    try {
      got = await resolveClaimId(CONTRACT, p.actionId, p.maker, p.afterId)
    } catch (e) {
      got = `THREW: ${e.message}`
    }
    if (got === want) pass++
    else failures.push({ ...p, want, got })
  }

  console.log(`\nprobes: ${probes.length}  pass: ${pass}  fail: ${failures.length}`)
  for (const f of failures.slice(0, 20)) {
    console.log(`  FAIL action=${f.actionId} claimer=${f.maker} after=${f.afterId} want=${f.want} got=${f.got} [${f.kind}]`)
  }

  // A pair whose claims are exhausted must fail loud, never invent an id.
  const [anyKey, anyIds] = [...byPair.entries()][0]
  const [anyAction, anyMaker] = anyKey.split('|')
  let exhausted = 'did not throw'
  try {
    await resolveClaimId(CONTRACT, anyAction, anyMaker, Math.max(...anyIds))
  } catch (e) {
    exhausted = 'threw as required'
  }
  console.log(`exhausted-pair probe: ${exhausted}`)

  process.exit(failures.length === 0 && exhausted === 'threw as required' ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
