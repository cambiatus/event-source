const http = require('http')
const https = require('https')
const { URL } = require('url')
const { AbstractActionReader } = require('demux')

const HEAD_REFRESH_MS = 2000
const BATCH_SIZE = 100

// The start of a node response, for error messages.
function excerpt (body) {
  return JSON.stringify(body).slice(0, 200)
}

// An error body (429 Busy, 500...) has no actions array; it must never pass for an empty page.
function assertActions (contract, result) {
  if (!Array.isArray(result.actions)) throw new Error(`get_actions for ${contract} returned no actions array: ${excerpt(result)}`)
}

class GetActionsReader extends AbstractActionReader {
  constructor (nodeUrl, contracts, startAtBlock) {
    super(startAtBlock)
    this.nodeUrl = nodeUrl
    this.contracts = contracts
    this.seqPositions = {}
    this.initialized = false
    this.pendingActions = []
    this.seenGlobalSeqs = new Set()
    this._headRefreshedAt = 0
    this._everReturnedBlock = false
    // Highest block whose actions are all loaded; nextBlock never hands over anything above it.
    this.emitLimit = 0
  }

  _post (path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.nodeUrl)
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

  async getHeadBlockNumber () {
    const now = Date.now()
    if (now - this._headRefreshedAt > HEAD_REFRESH_MS) {
      try {
        const info = await this._post('/v1/chain/get_info', {})
        // An error body (429 Busy...) has no head_block_num: keep the cached value.
        if (!Number.isSafeInteger(info.head_block_num)) throw new Error(`get_info returned no head_block_num: ${excerpt(info)}`)
        this.headBlockNumber = info.head_block_num
        this._headRefreshedAt = now
      } catch (e) {
        console.error('GetActionsReader: failed to fetch head block number:', e.message)
        // return cached value; will retry next time cache expires
      }
    }
    return this.headBlockNumber
  }

  // Fallback for base-class seekToBlock internals (private chain — no real forks)
  async getBlock (blockNumber) {
    return this._syntheticBlock(blockNumber)
  }

  _syntheticBlock (blockNumber) {
    return {
      blockInfo: {
        blockNumber,
        blockHash: `synthetic-${blockNumber}`,
        previousBlockHash: `synthetic-${blockNumber - 1}`,
        timestamp: new Date()
      },
      actions: []
    }
  }

  async _fetchActions (contract, pos, offset) {
    return this._post('/v1/history/get_actions', { account_name: contract, pos, offset })
  }

  // Binary search: first account_action_seq where block_num >= fromBlock
  async _findSeqForBlock (contract, fromBlock) {
    const lastResult = await this._fetchActions(contract, -1, -1)
    // An error body is not an empty history: returning 0 would re-read it all.
    assertActions(contract, lastResult)
    if (lastResult.actions.length === 0) return 0

    const last = lastResult.actions[0]
    if (last.block_num < fromBlock) {
      return last.account_action_seq + 1 // start past the end
    }

    const total = last.account_action_seq + 1
    let lo = 0
    let hi = total - 1

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const result = await this._fetchActions(contract, mid, 1)
      assertActions(contract, result)
      if (result.actions.length === 0) { hi = mid; continue }
      if (result.actions[0].block_num < fromBlock) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  async _initSeqPositions (fromBlock) {
    for (const contract of this.contracts) {
      this.seqPositions[contract] = await this._findSeqForBlock(contract, fromBlock)
      console.info(`GetActionsReader: ${contract} seq starts at ${this.seqPositions[contract]} (from block ${fromBlock})`)
    }
  }

  async initialize () {
    if (this.initialized) return
    console.info('GetActionsReader: locating start sequences...')
    await this._initSeqPositions(this.startAtBlock)
    this.initialized = true
    console.info('GetActionsReader: ready')
  }

  // Appends the rows at or below `limit` to pendingActions and advances the contract's sequence.
  _ingest (contract, contractIndex, rows, limit) {
    if (rows.length === 0) return
    // Seq-continuity guard: get_actions returns from `pos` forward, so the first row's
    // account_action_seq MUST equal what we asked for. A higher value means the history
    // node skipped sequences (a hole) — the actions in the gap would be silently lost.
    // Surface it loudly (Sentry via console.error) instead of discovering it later as a
    // stuck claim; we still process what we got.
    const firstSeq = rows[0].account_action_seq
    if (firstSeq > this.seqPositions[contract]) {
      console.error(`GetActionsReader: HISTORY GAP for ${contract} — expected seq ${this.seqPositions[contract]}, got ${firstSeq} (skipped ${firstSeq - this.seqPositions[contract]} action(s))`)
    }

    for (const action of rows) {
      // Rows come in seq order, so block_num never decreases: the rest is above the limit too.
      if (action.block_num > limit) break
      // Every row consumed advances the position, filtered or not, so a page of rows we
      // skip can't be refetched forever.
      this.seqPositions[contract] = action.account_action_seq + 1
      const act = action.action_trace.act
      if (act.account !== contract) continue
      if (this.seenGlobalSeqs.has(action.global_action_seq)) continue

      this.seenGlobalSeqs.add(action.global_action_seq)
      this.pendingActions.push({
        blockNum: action.block_num,
        contractIndex,
        blockTime: new Date(action.block_time + 'Z'),
        type: `${act.account}::${act.name}`,
        payload: {
          ...act,
          transactionId: action.action_trace.trx_id,
          actionIndex: action.account_action_seq,
          // Globally unique across contracts (account_action_seq is per contract and
          // collides between cambiatus.cm and cambiatus.tk). Key of the persistent
          // _processed_actions ledger — see updaters.js.
          globalSequence: action.global_action_seq
        }
      })
    }
  }

  // Loads the next page(s) of every contract and sets emitLimit: the highest block whose
  // actions are all loaded and final. Contracts are fetched one after another, so a block can
  // show up in one contract's page and not yet in another's; handing it over then would split it.
  // Every get_actions response carries the node's last_irreversible_block, read atomically with
  // its rows: a block <= it is final and complete in that response. The limit is the minimum
  // over all responses of the batch. A page that ends early (full, or cut off by the node's
  // time limit) proves nothing past its last row, so that contract only vouches for blocks
  // before it.
  //
  // Rows above the limit are never consumed. The history node runs speculative, so it can
  // serve rows of the pending block (head + 1): provisional, they may land in a later block
  // or never. They are dropped here and refetched next poll with their final data.
  // Nothing is ingested until every fetch has succeeded, so a failure leaves no partial state.
  async _loadNextBatch () {
    let limit = Infinity
    const fetched = []

    for (const contract of this.contracts) {
      const rows = []
      let pos = this.seqPositions[contract]
      for (;;) {
        const result = await this._fetchActions(contract, pos, BATCH_SIZE)
        // An error body is not an empty page: treating it as one would raise the limit
        // over blocks this contract never delivered. Throw; nextBlock retries next poll.
        assertActions(contract, result)
        if (!Number.isSafeInteger(result.last_irreversible_block)) throw new Error(`get_actions for ${contract} returned no last_irreversible_block: ${excerpt(result)}`)
        limit = Math.min(limit, result.last_irreversible_block)
        const page = result.actions
        const cutShort = result.time_limit_exceeded_error === true
        if (cutShort && page.length === 0) throw new Error(`get_actions for ${contract} timed out without a row at seq ${pos}`)
        if (page.length === 0) break
        // get_actions returns from `pos` forward; a lower first seq means the node ignored it.
        if (page[0].account_action_seq < pos) throw new Error(`get_actions for ${contract} ignored pos: asked ${pos}, got ${page[0].account_action_seq}`)
        rows.push(...page)
        if (page.length < BATCH_SIZE && !cutShort) break

        const last = page[page.length - 1]
        pos = last.account_action_seq + 1
        // A page inside one block says nothing about where that block ends: read on.
        if (page[0].block_num === last.block_num) continue
        limit = Math.min(limit, last.block_num - 1)
        break
      }
      fetched.push(rows)
    }

    if (!Number.isSafeInteger(limit)) throw new Error(`no usable block limit: ${limit}`)
    this.contracts.forEach((contract, i) => this._ingest(contract, i, fetched[i], limit))
    this.emitLimit = limit

    // Same order a single unsplit read produces: community, token, escrow inside a block.
    this.pendingActions.sort((a, b) =>
      a.blockNum - b.blockNum ||
      a.contractIndex - b.contractIndex ||
      a.payload.actionIndex - b.payload.actionIndex)
  }

  async seekToBlock (blockNumber) {
    // Called by watcher as seekToBlock(nextBlockNeeded - 1), so resume from blockNumber+1
    const resumeFrom = blockNumber + 1
    console.info(`GetActionsReader: seeking to block ${blockNumber}, will resume from ${resumeFrom}`)
    await this._initSeqPositions(resumeFrom)
    this.pendingActions = []
    this.seenGlobalSeqs = new Set()
    this.currentBlockNumber = blockNumber
    this.currentBlockData = this._syntheticBlock(blockNumber)
    this.headBlockNumber = 0
    this._headRefreshedAt = 0
    this.emitLimit = 0
  }

  async nextBlock () {
    if (!this.initialized) await this.initialize()

    await this.getHeadBlockNumber()

    const targetBlock = this.currentBlockNumber + 1

    // pendingActions only holds blocks at or below emitLimit (complete and final), so the first
    // pending action is next at its real block (the < case covers stale actions behind
    // currentBlockNumber, e.g. after a seekToBlock that overshoots the last indexed action),
    // or a synthetic gap block when it is ahead.
    if (this.pendingActions.length === 0) {
      // Catch transient network errors so we don't crash
      try {
        await this._loadNextBatch()
      } catch (e) {
        console.error('GetActionsReader: network error fetching actions, will retry next poll:', e.message)
        return [this.currentBlockData || this._syntheticBlock(this.currentBlockNumber), false, false]
      }
    }

    if (this.pendingActions.length > 0) {
      const nextActionBlock = this.pendingActions[0].blockNum
      return nextActionBlock <= targetBlock
        ? this._returnActionBlock(nextActionBlock)
        : this._returnSyntheticBlock(targetBlock)
    }

    // Nothing complete left — jump to emitLimit (the last irreversible block, unless a short
    // page holds it back) so the watcher exits the polling loop. Never backwards, never past
    // emitLimit.
    if (Number.isSafeInteger(this.emitLimit)) this.currentBlockNumber = Math.max(this.currentBlockNumber, this.emitLimit)
    this.currentBlockData = this._syntheticBlock(this.currentBlockNumber)
    this.isFirstBlock = false
    return [this.currentBlockData, false, false] // isNewBlock=false → watcher breaks
  }

  _returnSyntheticBlock (blockNumber) {
    const blockData = this._syntheticBlock(blockNumber)
    this.currentBlockData = blockData
    this.currentBlockNumber = blockNumber
    this.isFirstBlock = !this._everReturnedBlock
    this._everReturnedBlock = true
    return [blockData, false, true]
  }

  _returnActionBlock (blockNumber) {
    const blockTime = this.pendingActions[0].blockTime
    const actions = []
    while (this.pendingActions.length > 0 && this.pendingActions[0].blockNum === blockNumber) {
      const { type, payload } = this.pendingActions.shift()
      actions.push({ type, payload })
    }
    console.info(`GetActionsReader: block ${blockNumber} — ${actions.map(a => a.type).join(', ')}`)
    const blockData = {
      blockInfo: {
        blockNumber,
        blockHash: `synthetic-${blockNumber}`,
        previousBlockHash: `synthetic-${blockNumber - 1}`,
        timestamp: blockTime
      },
      actions
    }
    this.currentBlockData = blockData
    this.currentBlockNumber = blockNumber
    this.isFirstBlock = !this._everReturnedBlock
    this._everReturnedBlock = true
    return [blockData, false, true]
  }
}

module.exports = { GetActionsReader }
