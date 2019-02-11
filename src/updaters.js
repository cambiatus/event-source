const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const Sentry = require('@sentry/node');
const { parseToken } = require('./eos_helper')

function updateTransferData(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Transfer`)

  const [ amount, symbol ] = parseToken(payload.data.value)

  const transferData = {
    from: payload.data.from,
    to: payload.data.to,
    amount: amount,
    symbol: symbol,
    memo: payload.data.memo,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  db.transfers.insert(transferData)
    .catch(e => {
      console.error('Something went wrong while updating transfer data', e)
      Sentry.captureException(e);
    })
}

function updateCreateCommunity(db, payload, blockInfo) {
  console.log(`BeSpiral >>> New Community`)

  const [ _, symbol ] = parseToken(payload.data.max_supply)

  const communityData = {
    symbol: symbol,
    parent_community: payload.data.parent_community,
    issuer: payload.data.issuer,
    creator: payload.data.creator,
    logo: payload.data.logo,
    name: payload.data.title,
    description: payload.data.description,
    supply: parseToken(payload.data.max_supply)[0],
    min_balance: parseToken(payload.data.min_balance)[0],
    inviter_reward: parseToken(payload.data.inviter_reward)[0],
    invited_reward: parseToken(payload.data.invited_reward)[0],
    allow_subcommunity: payload.data.allow_subc == 1 ? true : false,
    subcommunity_price: parseToken(payload.data.subc_price)[0],
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  // create community
  db.communities.insert(communityData)
    .catch(e => {
      console.error('Something went wrong while inserting a new community', e)
      Sentry.captureException(e);
    })

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
    .catch(e => {
      console.error('Something went wrong while adding community creator to network', e)
      Sentry.captureException(e);
    })
}

function updateCommunityLogo(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Update community logo`, payload)

  const [ _, symbol ] = parseToken(payload.data.cmm_asset)

  const updateData = {
    logo: payload.data.logo
  }
  // Find the community
  db.communities.update({ symbol: symbol }, updateData)
    .catch(e => {
      console.error('Something went wrong while updating community logo', e)
      Sentry.captureException(e);
    })
}

function updateNetlink(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Invites`)

  const [ _, symbol ] = parseToken(payload.data.cmm_asset)

  const networkData = {
    community_symbol: symbol,
    account: payload.data.new_user,
    invited_by: payload.authorization[0].actor,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  db.network.insert(networkData)
    .catch(e => {
      console.error('Something went wrong while adding user to network table', e)
      Sentry.captureException(e);
    })

  // Check if user isn't already created
  db.users.count({account: payload.data.new_user})
    .then(total => {
      if (total === "0") {
        const profileData = {
          account: payload.data.new_user,
          created_block: blockInfo.blockNumber,
          created_tx: payload.transactionId,
          created_at: blockInfo.timestamp,
          created_eos_account: payload.authorization[0].actor
        }

        db.users.insert(profileData)
          .catch(e => {
            console.error('Something went wrong while adding user to users table', e)
            Sentry.captureException(e);
          })
      }
    })
    .catch(e => {
      console.error('Something went wrong while counting for existing users', e)
      Sentry.captureException(e);
    })
}

function updateNewSaleData(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Sale`)

  const [ price, symbol ] = parseToken(payload.data.quantity)

  const data = {
    account: payload.data.from,
    title: payload.data.title,
    description: payload.data.description,
    price: price,
    symbol: symbol,
    rate: 0,
    rate_count: 0,
    image: payload.data.image,
    is_buy: payload.data.is_buy
  }

  db.shop.insert(data)
    .catch(e => {
      console.error('Something went wrong while updating transfer data', e)
      Sentry.captureException(e);
    })
}

// function updateIssues(state, payload, blockInfo, context) {
//   state.totalCommunities += 1
//   // TODO: Add a `available_supply` on `communities` table and decrease it on every issue
//   console.log(`BeSpiral >>> New Currency Issue -- Total: ${state.totalIssues}`)
// }

function updateNewObjective(state, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Objective`)

  console.log('this is the data', payload.data)
}

// function updateNewAction(state, payload, blockInfo, context) {
//   console.log('TODO: IMPLEMENT updateNewAction')
// }

// function updateVerifyAction(state, payload, blockInfo, context) {
//   console.log('TODO: IMPLEMENT updateVerifyAction')
// }

const updaters = [
  {
    actionType: `${config.blockchain.contract}::createcmm`,
    updater: updateCreateCommunity
  },
  {
    actionType: `${config.blockchain.contract}::updatelogo`,
    updater: updateCommunityLogo
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
  },
  {
    actionType: `${config.blockchain.contract}::newsale`,
    updater: updateNewSaleData
  },
  {
    actionType: `${config.blockchain.contract}::newobjective`,
    updater: updateNewObjective
  },
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
