const http = require('http')
const https = require('https')
const { URL } = require('url')
const { AbstractActionReader } = require('demux')

const HEAD_REFRESH_MS = 2000

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
    if (!lastResult.actions || lastResult.actions.length === 0) return 0

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
      if (!result.actions || result.actions.length === 0) { hi = mid; continue }
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

  async _loadNextBatch () {
    const BATCH_SIZE = 100
    let anyNew = false

    for (const contract of this.contracts) {
      const result = await this._fetchActions(contract, this.seqPositions[contract], BATCH_SIZE)
      if (!result.actions || result.actions.length === 0) continue

      for (const action of result.actions) {
        const act = action.action_trace.act
        if (act.account !== contract) continue
        if (this.seenGlobalSeqs.has(action.global_action_seq)) continue

        this.seenGlobalSeqs.add(action.global_action_seq)
        this.pendingActions.push({
          blockNum: action.block_num,
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

        anyNew = true
        this.seqPositions[contract] = action.account_action_seq + 1
      }
    }

    if (anyNew) {
      this.pendingActions.sort((a, b) => a.blockNum - b.blockNum)
    }

    return anyNew
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
  }

  async nextBlock () {
    if (!this.initialized) await this.initialize()

    await this.getHeadBlockNumber()

    const targetBlock = this.currentBlockNumber + 1

    // If we have a pending action at or before targetBlock, process it at its real block.
    // The < case handles stale actions whose blockNum is behind currentBlockNumber (e.g.
    // after a seekToBlock that overshoots the last indexed action).
    if (this.pendingActions.length > 0 && this.pendingActions[0].blockNum <= targetBlock) {
      return this._returnActionBlock(this.pendingActions[0].blockNum)
    }

    // If pending action is AHEAD of targetBlock, fill gap with synthetic block
    if (this.pendingActions.length > 0 && this.pendingActions[0].blockNum > targetBlock) {
      return this._returnSyntheticBlock(targetBlock)
    }

    // Buffer empty — try to load more (catch transient network errors so we don't crash)
    if (this.pendingActions.length === 0) {
      try {
        await this._loadNextBatch()
      } catch (e) {
        console.error('GetActionsReader: network error fetching actions, will retry next poll:', e.message)
        return [this.currentBlockData || this._syntheticBlock(this.currentBlockNumber), false, false]
      }
    }

    if (this.pendingActions.length > 0) {
      if (this.pendingActions[0].blockNum <= targetBlock) {
        return this._returnActionBlock(this.pendingActions[0].blockNum)
      }
      // Next action is ahead — fill gap
      return this._returnSyntheticBlock(targetBlock)
    }

    // No more actions — jump to head so watcher exits the polling loop
    this.currentBlockNumber = this.headBlockNumber
    this.currentBlockData = this._syntheticBlock(this.headBlockNumber)
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
