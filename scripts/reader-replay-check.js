// Read-only check of GetActionsReader against a live history API: replays blocks S..E through
// the reader, dumps the same range per contract with plain get_actions paging, and compares.
//   node scripts/reader-replay-check.js [--url https://app.cambiatus.io] [--last 200000] [--from S --to E]
// Only POSTs /v1/chain/get_info and /v1/history/get_actions, at most 5 requests per second.
const { GetActionsReader } = require('../src/GetActionsReader')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const URL_BASE = opt('url', 'https://app.cambiatus.io')
const CONTRACTS = ['cambiatus.cm', 'cambiatus.tk', 'cambiatus.es']
const MIN_GAP_MS = 200

let lastRequestAt = 0
let requests = 0
let queue = Promise.resolve()
let badPages = 0 // history API replies without an actions array (seen in the wild)

function throttled (fn) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
    requests++
    return fn()
  })
  queue = run.catch(() => {})
  return run
}

const post = reader => (path, body) => throttled(() => GetActionsReader.prototype._post.call(reader, path, body))

// Independent first account_action_seq with block_num >= fromBlock (plain binary search).
async function seqFor (api, contract, fromBlock) {
  const last = (await api('/v1/history/get_actions', { account_name: contract, pos: -1, offset: -1 })).actions
  if (!last || last.length === 0) return 0
  if (last[0].block_num < fromBlock) return last[0].account_action_seq + 1
  let lo = 0
  let hi = last[0].account_action_seq
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const r = (await api('/v1/history/get_actions', { account_name: contract, pos: mid, offset: 1 })).actions
    if (r && r.length && r[0].block_num < fromBlock) lo = mid + 1
    else hi = mid
  }
  return lo
}

async function dump (api, from, to) {
  const rows = new Map() // global_action_seq -> { block, contract }
  for (const contract of CONTRACTS) {
    let pos = await seqFor(api, contract, from)
    let done = false
    while (!done) {
      let res
      for (let attempt = 0; attempt < 5; attempt++) {
        res = await api('/v1/history/get_actions', { account_name: contract, pos, offset: 100 })
        if (Array.isArray(res.actions)) break
        badPages++
      }
      if (!Array.isArray(res.actions)) throw new Error(`dump: bad page for ${contract} at ${pos}`)
      const page = res.actions
      for (const a of page) {
        if (a.block_num > to) { done = true; break }
        if (a.action_trace.act.account === contract) rows.set(a.global_action_seq, { block: a.block_num, contract })
      }
      if (page.length < 100) done = true
      else pos = page[page.length - 1].account_action_seq + 1
    }
  }
  return rows
}

async function main () {
  const reader = new GetActionsReader(URL_BASE, CONTRACTS, 1)
  reader._post = post(reader)
  const api = reader._post
  const head = (await api('/v1/chain/get_info', {})).head_block_num
  const to = Number(opt('to', head - 20))
  const from = Number(opt('from', to - Number(opt('last', 200000))))
  console.log(`range ${from}..${to} (head ${head})`)

  const info = console.info
  console.info = () => {}
  reader.startAtBlock = from
  reader.currentBlockNumber = from - 1
  await reader.initialize()

  const handed = new Map() // global_action_seq -> [block numbers it came in]
  const blocks = []
  let withActions = 0
  let multiContract = 0
  let prev = from - 1
  let violations = 0
  while (reader.currentBlockNumber < to) {
    const [b, , isNew] = await reader.nextBlock()
    if (!isNew) {
      if (reader.currentBlockNumber >= to) break
      await new Promise(resolve => setTimeout(resolve, 500))
      continue
    }
    const n = b.blockInfo.blockNumber
    if (n > to) break
    if (n <= prev) { violations++; console.log(`block ${n} not after ${prev}: ${b.actions.map(a => `${a.type}#${a.payload.actionIndex}`).join(', ')}`) }
    prev = n
    blocks.push(n)
    if (b.actions.length === 0) continue
    withActions++
    if (new Set(b.actions.map(a => a.type.split('::')[0])).size > 1) multiContract++
    for (const a of b.actions) {
      const list = handed.get(a.payload.globalSequence) || []
      list.push(n)
      handed.set(a.payload.globalSequence, list)
    }
  }
  console.info = info

  const expected = await dump(api, from, to)
  let missing = 0
  let wrongBlock = 0
  let dupes = 0
  for (const [g, { block }] of expected) {
    const got = handed.get(g)
    if (!got) {
      missing++
      continue
    }
    if (got.length > 1) dupes++
    if (got[0] !== block) wrongBlock++
  }
  const extra = [...handed.keys()].filter(g => !expected.has(g)).length
  const perContract = Object.fromEntries(CONTRACTS.map(c => [c, [...expected.values()].filter(v => v.contract === c).length]))
  console.log(JSON.stringify({
    range: [from, to],
    requests,
    dumpBadPagesRetried: badPages,
    dumpActions: expected.size,
    actionsPerContract: perContract,
    handedActions: handed.size,
    blocksWithActions: withActions,
    blocksWithMoreThanOneContract: multiContract,
    missing,
    extra,
    duplicatedActions: dupes,
    actionInWrongBlock: wrongBlock,
    nonIncreasingBlocks: violations
  }, null, 2))
  const ok = missing === 0 && extra === 0 && dupes === 0 && wrongBlock === 0 && violations === 0
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
