const config = require('./config')

function updateTransferData(state, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Transfer`)
}

function updateCreateCommunity(db, payload, blockInfo) {
  console.log(`BeSpiral >>> New Community`)

  const { _, symbol } = parseToken(payload.data.max_supply)

  const communityData = {
    symbol: symbol,
    parent_community: payload.data.parent_community,
    issuer: payload.data.issuer,
    creator: payload.data.creator,
    logo: payload.data.logo,
    name: payload.data.title,
    description: payload.data.description,
    supply: parseTokenAmount(payload.data.max_supply),
    min_balance: parseTokenAmount(payload.data.min_balance),
    inviter_reward: parseTokenAmount(payload.data.inviter_reward),
    invited_reward: parseTokenAmount(payload.data.invited_reward),
    allow_subcommunity: payload.data.allow_subc == 1 ? true : false,
    subcommunity_price: parseTokenAmount(payload.data.subc_price),
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  // create community
  db.communities.insert(communityData)

  const networkData = {
    community_symbol: symbol,
    account: payload.data.creator,
    invited_by: payload.data.creator,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  // invite community creator
  db.network.insert(networkData)
}

function updateNetlink(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Invites`)

  const { _, symbol } = parseToken(payload.data.cmm_asset)

  const data = {
    community_symbol: symbol,
    account: payload.data.new_user,
    invited_by: payload.authorization[0].actor,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  db.network.insert(data)
}

// function updateIssues(state, payload, blockInfo, context) {
//   state.totalCommunities += 1
//   // TODO: Add a `available_supply` on `communities` table and decrease it on every issue
//   console.log(`BeSpiral >>> New Currency Issue -- Total: ${state.totalIssues}`)
// }

// function updateNewObjective(state, payload, blockInfo, context) {
//   console.log('TODO: IMPLEMENT updateNewObjective')
// }

// function updateNewAction(state, payload, blockInfo, context) {
//   console.log('TODO: IMPLEMENT updateNewAction')
// }

// function updateVerifyAction(state, payload, blockInfo, context) {
//   console.log('TODO: IMPLEMENT updateVerifyAction')
// }

function parseToken(tokenString) {
  const [amountString, symbol] = tokenString.split(" ")
  const amount = parseFloat(amountString)
  return { amount, symbol }
}

function parseTokenAmount(tokenString) {
  const { amount, _symbol } = parseToken(tokenString)
  return amount
}

const updaters = [
  {
    actionType: `${config.blockchain.contract}::createcmm`,
    updater: updateCreateCommunity
  },
  {
    actionType: `${config.blockchain.contract}::netlink`,
    updater: updateNetlink
  },
  // {
  //   actionType: `${config.blockchain.contract}::issue`,
  //   updater: updateIssues
  // },
  {
    actionType: `${config.blockchain.contract}::transfer`,
    updater: updateTransferData
  }//,
  // {
  //   actionType: `${config.blockchain.contract}::newobjective`,
  //   updater: updateNewObjective
  // },
  // {
  //   actionType: `${config.blockchain.contract}::newaction`,
  //   updater: updateNewAction
  // },
  // {
  //   actionType: `${config.blockchain.contract}::verifyaction`,
  //   updater: updateVerifyAction
  // },
]

module.exports = updaters
