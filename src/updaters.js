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

const updaters = [
  {
    actionType: "bespiralcom1::createcmm",
    updater: updateTransferData,
  },
  {
    actionType: "bespiralcom1::netlink",
    updater: updateTransferData,
  },
  {
    actionType: "bespiralcom1::issue",
    updater: updateTransferData,
  },
  {
    actionType: "bespiralcom1::transfer",
    updater: updateTransferData,
  },
]

module.exports = updaters