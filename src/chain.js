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

// Fetch every on-chain claim for a single action via the `byaction` secondary
// index (index_position 2). An action realistically has far fewer than the limit;
// if the node still reports more, throw so we never compute an ordinal off a
// truncated set (fail-safe — the block retries).
async function claimsForAction (communityContract, actionId) {
  const res = await post('/v1/chain/get_table_rows', {
    json: true,
    code: communityContract,
    scope: communityContract,
    table: 'claim',
    index_position: 2,
    key_type: 'i64',
    lower_bound: actionId,
    upper_bound: actionId,
    limit: 5000
  })
  if (!res || !Array.isArray(res.rows)) throw new Error(`get_table_rows(claim) returned no rows for action ${actionId}`)
  if (res.more) throw new Error(`too many claims for action ${actionId} to page safely`)
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
// many claims yet, so a transient/ordering problem retries the block instead of
// writing a wrong id.
async function resolveClaimId (communityContract, actionId, maker, ordinal) {
  const mine = (await claimsForAction(communityContract, actionId))
    .filter(c => c.claimer === maker)
    .sort((a, b) => Number(a.id) - Number(b.id))

  const claim = mine[ordinal]
  if (!claim) {
    throw new Error(
      `resolveClaimId: chain has ${mine.length} claims for action ${actionId} / ${maker}, ` +
      `need index ${ordinal}. Retrying block.`
    )
  }
  return Number(claim.id)
}

module.exports = { resolveClaimId }
