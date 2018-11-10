const config = require('./config')

function updateTransferData(state, payload, blockInfo, context) {
  state.totalTransfers += 1
  console.log(`BeSpiral >>> New Transfer -- Total: ${state.totalTransfers}`)
}

function updateCreateCommunity(state, payload, blockInfo, context) {
  state.totalCommunities += 1
  console.log(`BeSpiral >>> New Community -- Total: ${state.totalCreatecmms}`)
}

function updateNetlink(state, payload, blockInfo, context) {
  state.totalCommunities += 1
  console.log(`BeSpiral >>> New Invites -- Total: ${state.totalNetlinks}`)
}

function updateIssues(state, payload, blockInfo, context) {
  state.totalCommunities += 1
  console.log(`BeSpiral >>> New Currency Issue -- Total: ${state.totalIssues}`)
}

function updateNewObjective(state, payload, blockInfo, context) {
  console.log('TODO: IMPLEMENT updateNewObjective')
}

function updateNewAction(state, payload, blockInfo, context) {
  console.log('TODO: IMPLEMENT updateNewAction')
}

function updateVerifyAction(state, payload, blockInfo, context) {
  console.log('TODO: IMPLEMENT updateVerifyAction')
}

const updaters = [
  {
    actionType: `${config.blockchain.config}::createcmm`,
    updater: updateCreateCommunity
  },
  {
    actionType: `${config.blockchain.config}::netlink`,
    updater: updateNetlink
  },
  {
    actionType: `${config.blockchain.contract}::issue`,
    updater: updateIssues
  },
  {
    actionType: `${config.blockchain.contract}::transfer`,
    updater: updateTransferData
  },
  {
    actionType: `${config.blockchain.contract}::newobjective`,
    updater: updateNewObjective
  },
  {
    actionType: `${config.blockchain.contract}::newaction`,
    updater: updateNewAction
  },
  {
    actionType: `${config.blockchain.contract}::verifyaction`,
    updater: updateVerifyAction
  },
]

module.exports = updaters
