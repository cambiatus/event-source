// Acceptance check for chain.js/resolveCreatedActionId and
// resolveCreatedObjectiveId against a REAL node.
//
//   NODE_ENV=prod BLOCKCHAIN_URL=https://app.cambiatus.io \
//   BLOCKCHAIN_COMMUNITY_CONTRACT=cambiatus.cm BLOCKCHAIN_TOKEN_CONTRACT=cambiatus.tk \
//   node scripts/verify-create-resolvers.js
//
// Both resolvers answer "which id did the contract just generate?" with: the
// smallest chain id for this parent that the DB does not have yet. So replay the
// creation history of every parent — knownIds = the first k ids, ask for the
// next — and require the resolver to name id k+1 every time. Then confirm an
// exhausted parent throws rather than inventing an id.
//
// This is the check that would have caught the failure the serial fallback hid:
// a truncated chain read makes a real id look missing, and the resolver hands
// back an id that belongs to a different action.

const config = require(`../src/config/${process.env.NODE_ENV || 'dev'}`)
const { resolveCreatedActionId, resolveCreatedObjectiveId } = require('../src/chain')

const CONTRACT = config.blockchain.contract.community

async function check (label, ids, resolve) {
  let pass = 0
  const failures = []

  // Replay the parent's creation order: with the first k ids known, the next
  // create must resolve to ids[k].
  for (let k = 0; k < ids.length; k++) {
    const known = new Set(ids.slice(0, k))
    let got
    try {
      got = await resolve(known)
    } catch (e) {
      got = `THREW: ${e.message}`
    }
    if (got === ids[k]) pass++
    else failures.push({ k, want: ids[k], got })
  }

  // Everything known -> nothing left to create -> must throw.
  let exhausted = 'did not throw'
  try {
    await resolve(new Set(ids))
  } catch (e) {
    exhausted = 'threw as required'
  }

  const ok = failures.length === 0 && exhausted === 'threw as required'
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${pass}/${ids.length} steps, exhausted-probe ${exhausted}`)
  for (const f of failures.slice(0, 5)) {
    console.log(`      step ${f.k}: want ${f.want} got ${f.got}`)
  }
  return ok
}

async function main () {
  console.log(`node: ${config.blockchain.url}  contract: ${CONTRACT}`)

  // Communities to exercise, read off chain so this is not hardcoded to muda.
  const https = require('https')
  const post = (path, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const url = new URL(path, config.blockchain.url)
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })

  const cmm = await post('/v1/chain/get_table_rows', {
    json: true, code: CONTRACT, scope: CONTRACT, table: 'community', limit: 1000
  })
  const symbols = (cmm.rows || []).map(c => c.symbol)
  console.log(`communities: ${symbols.length}`)

  let allOk = true

  // ---- objectives, per community -----------------------------------------
  let objChecked = 0
  for (const symbol of symbols) {
    // The resolver has its own reader; to know the EXPECTED ids we read the
    // community's objective scope independently here.
    const raw = (() => {
      const [precision, code] = symbol.split(',')
      let v = BigInt(precision)
      for (let i = 0; i < code.length; i++) v |= BigInt(code.charCodeAt(i)) << BigInt(8 * (i + 1))
      return v.toString()
    })()
    const page = await post('/v1/chain/get_table_rows', {
      json: true, code: CONTRACT, scope: raw, table: 'objective', limit: 1000
    })
    const ids = (page.rows || []).map(o => Number(o.id)).sort((a, b) => a - b)
    if (ids.length === 0) continue
    objChecked++
    const ok = await check(
      `objectives of ${symbol}`,
      ids,
      known => resolveCreatedObjectiveId(CONTRACT, symbol, known)
    )
    allOk = allOk && ok
  }
  console.log(`communities with objectives checked: ${objChecked}`)

  // ---- actions, per objective --------------------------------------------
  const actions = await post('/v1/chain/get_table_rows', {
    json: true, code: CONTRACT, scope: CONTRACT, table: 'action', limit: 1000
  })
  // Page the rest (one call is never the whole table).
  let all = actions.rows || []
  let more = actions.more
  let lb = actions.next_key
  while (more) {
    const p = await post('/v1/chain/get_table_rows', {
      json: true, code: CONTRACT, scope: CONTRACT, table: 'action', lower_bound: Number(lb), limit: 1000
    })
    all = all.concat(p.rows || [])
    more = p.more
    lb = p.next_key
  }
  const byObjective = new Map()
  for (const a of all) {
    const o = Number(a.objective_id)
    if (!byObjective.has(o)) byObjective.set(o, [])
    byObjective.get(o).push(Number(a.id))
  }
  console.log(`actions: ${all.length} across ${byObjective.size} objectives`)

  // Checking every objective means re-reading the action table once per step,
  // which is slow; sample the busiest ones plus a spread of the rest.
  const objectives = [...byObjective.entries()].sort((a, b) => b[1].length - a[1].length)
  const sample = objectives.slice(0, 3).concat(objectives.slice(3).filter((_, i) => i % 20 === 0))
  for (const [objectiveId, ids] of sample) {
    ids.sort((a, b) => a - b)
    const ok = await check(
      `actions of objective ${objectiveId}`,
      ids,
      known => resolveCreatedActionId(CONTRACT, objectiveId, known)
    )
    allOk = allOk && ok
  }

  console.log(allOk ? '\nALL CHECKS PASS' : '\nFAILURES PRESENT')
  process.exit(allOk ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
