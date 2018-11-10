// const amqp = require("./amqp")
const { AbstractActionHandler } = require("demux")

// Initial state
const state = {
  totalTransfers: 0,
  totalCreatecmms: 0,
  totalNetlinks: 0,
  totalIssues: 0,
  indexState: { blockNumber: 0, blockHash: "" },
  amqpSender: null
}

class ObjectActionHandler extends AbstractActionHandler {
  async handleWithState(handle) {

    // const amqpSender = await amqp()
    const initialState = state
    // initialState.amqpSender = amqpSender

    await handle(initialState)
  }

  async loadIndexState() {
    // console.info("Loading initial state >>> ", state.indexState)
    return state.indexState
  }

  async updateIndexState(stateObj, block) {
    stateObj.indexState.blockNumber = block.blockInfo.blockNumber
    stateObj.indexState.blockHash = block.blockInfo.blockHash
    // console.info("Index state updated >>> ", state.indexState)
  }

  async rollbackTo(blockNumber) {
    throw Error(`Cannot roll back to ${blockNumber}; \`rollbackTo\` not implemented.`)
  }
}

module.exports = ObjectActionHandler
