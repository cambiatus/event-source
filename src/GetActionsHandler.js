const { MassiveActionHandler } = require('demux-postgres')

// Extends MassiveActionHandler to work with GetActionsReader:
// - Skips sequential block number and hash checks (get_actions guarantees ordering)
// - Skips DB writes for empty gap-filling blocks (only writes for action blocks)
class GetActionsHandler extends MassiveActionHandler {
  async handleBlock (block, isRollback, isFirstBlock, isReplay = false) {
    const { blockInfo } = block

    // Load persisted state on first ever call
    if (!this.lastProcessedBlockHash && this.lastProcessedBlockNumber === 0) {
      await this.refreshIndexState()
    }

    // Skip if we've already processed this exact block
    if (
      blockInfo.blockNumber === this.lastProcessedBlockNumber &&
      blockInfo.blockHash === this.lastProcessedBlockHash
    ) {
      return [false, 0]
    }

    // On fresh start with existing state, tell watcher to seek to resume position
    if (isFirstBlock && this.lastProcessedBlockHash) {
      return [true, this.lastProcessedBlockNumber + 1]
    }

    // Empty block — update in-memory state only, no DB transaction
    if (!block.actions || block.actions.length === 0) {
      this.lastProcessedBlockNumber = blockInfo.blockNumber
      this.lastProcessedBlockHash = blockInfo.blockHash
      return [false, 0]
    }

    // Action block — run full pipeline inside a DB transaction
    await this.handleWithState(async (state, context = {}) => {
      await this.handleActions(state, block, context, isReplay)
    })

    return [false, 0]
  }

  // Override to use ON CONFLICT DO NOTHING for _block_number_txid.
  // Re-processed blocks (e.g. after switching from NodeosActionReader) would otherwise
  // crash with a duplicate key violation since that table has no upsert support.
  async updateIndexState (state, block, isReplay, context) {
    const { blockInfo } = block
    // demux reads the resume point from row id=1 only (loadIndexState). Upsert
    // that row explicitly: a save() without an id — what an empty table gave —
    // inserted a fresh serial row per block, so id=1 never existed and every
    // restart replayed from block 1.
    await state.instance.none(
      `INSERT INTO _index_state (id, block_number, block_hash, is_replay) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash, is_replay = EXCLUDED.is_replay`,
      [blockInfo.blockNumber, blockInfo.blockHash, isReplay]
    )
    await state.instance.none(
      'INSERT INTO _block_number_txid (block_number, txid) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [blockInfo.blockNumber, context.txid]
    )
  }
}

module.exports = { GetActionsHandler }
