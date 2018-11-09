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
    actionType: "bespiralcom1::createcmm",
    updater: updateCreateCommunity
  },
  {
    actionType: "bespiralcom1::netlink",
    updater: updateNetlink
  },
  {
    actionType: "bespiralcom1::issue",
    updater: updateIssues
  },
  {
    actionType: "bespiralcom1::transfer",
    updater: updateTransferData
  },
  {
    actionType: "bespiralcom1::newobjective",
    updater: updateNewObjective
  },
  {
    actionType: "bespiralcom1::newaction",
    updater: updateNewAction
  },
  {
    actionType: "bespiralcom1::verifyaction",
    updater: updateVerifyAction
  },
]

module.exports = updaters
