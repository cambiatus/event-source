const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const Sentry = require('@sentry/node');
const { parseToken } = require('./eos_helper')

function updateTransferData(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Transfer`)

  const [ amount, symbol ] = parseToken(payload.data.value)

  const transferData = {
    from_id: payload.data.from,
    to_id: payload.data.to,
    amount: amount,
    community_id: symbol,
    memo: payload.data.memo,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp,
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
    parent_community_id: payload.data.parent_community,
    issuer: payload.data.issuer,
    creator: payload.data.creator,
    logo: payload.data.logo,
    name: payload.data.title,
    description: payload.data.description,
    supply: 0,
    max_supply: parseToken(payload.data.max_supply)[0],
    min_balance: parseToken(payload.data.min_balance)[0],
    inviter_reward: parseToken(payload.data.inviter_reward)[0],
    invited_reward: parseToken(payload.data.invited_reward)[0],
    allow_subcommunity: payload.data.allow_subc == 1 ? true : false,
    subcommunity_price: parseToken(payload.data.subc_price)[0],
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  // create community
  db.communities.insert(communityData)
    .then(() => {
      const networkData = {
        community_id: symbol,
        account_id: payload.data.creator,
        invited_by_id: payload.data.creator,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      }

      // invite community creator
      db.network.insert(networkData)
        .catch(e => {
          console.error('Something went wrong while adding community creator to network', e)
          Sentry.captureException(e);
        })
    })
    .catch(e => {
      console.error('Something went wrong while inserting a new community', e)
      Sentry.captureException(e);
    })
}

function updateCommunityLogo(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Update community logo`)

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
  console.log(`BeSpiral >>> New Netlink`)

  // Check if user isn't already created
  db.users.count({account: payload.data.new_user})
    .then(total => {
      const profileData = {
        account: payload.data.new_user,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      }

      if (total === "0") {
        db.users.insert(profileData)
          .catch(e => {
            console.error('Something went wrong while inserting user', e)
            Sentry.captureException(e);
          })
      } else {
        db.users.update(profileData)
          .catch(e => {
            console.error('Something went wrong while updating user', e)
            Sentry.captureException(e);
          })
      }
    })
    .then(() => {
      const [ _, symbol ] = parseToken(payload.data.cmm_asset)

      const networkData = {
        community_id: symbol,
        account_id: payload.data.new_user,
        invited_by_id: payload.authorization[0].actor,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      }

      db.network.insert(networkData)
        .catch(e => {
          console.error('Something went wrong while adding user to network table', e)
          Sentry.captureException(e);
        })
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
    community_id: symbol,
    title: payload.data.title,
    description: payload.data.description,
    price: price,
    rate: 0,
    image: payload.data.image,
    is_buy: payload.data.is_buy === 1,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  db.shop.insert(data)
    .catch(e => {
      console.error('Something went wrong while updating transfer data', e)
      Sentry.captureException(e);
    })
}

function updateIssue(db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Issue`)

  const [ amount, symbol ] = parseToken(payload.data.quantity)
  const data = {
    community_id: symbol,
    to_id: payload.data.to,
    quantity: amount,
    memo: payload.data.memo,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  db.community_mints.insert(data)
    .catch(e => {
      console.error('Something went wrong while adding mint to community_mints table', e)
      Sentry.captureException(e);
    })
}

// function updateNewObjective(db, payload, blockInfo, context) {
//   console.log(`BeSpiral >>> New Objective`, payload.data)

//   // Add to objective table
//   const objectiveData = {
//     community: payload.data.cmm_asset,
//     description: payload.data.description,
//     created_block: blockInfo.blockNumber,
//     created_tx: payload.transactionId,
//     created_at: blockInfo.timestamp,
//     created_eos_account: payload.authorization[0].actor
//   }

//   db.objectives.insert(objectiveData)
//     .catch(e => {
//       console.error('Something went wrong creating objective', e)
//       Sentry.captureException(e);
//     })
// }

// function updateNewAction(state, payload, blockInfo, context) {
//   console.log(`BeSpiral >>> New Objective Action`, payload.data)
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
  {
    actionType: `${config.blockchain.contract}::issue`,
    updater: updateIssue
  },
  {
    actionType: `${config.blockchain.contract}::transfer`,
    updater: updateTransferData
  },
  {
    actionType: `${config.blockchain.contract}::newsale`,
    updater: updateNewSaleData
  },
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
