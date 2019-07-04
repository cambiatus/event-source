const Sentry = require('@sentry/node')
const {
  parseToken
} = require('../eos_helper')

function createCommunity (db, payload, blockInfo) {
  console.log(`BeSpiral >>> Create Community`)

  const [, symbol] = parseToken(payload.data.cmm_asset)

  const communityData = {
    symbol: symbol,
    creator: payload.data.creator,
    logo: payload.data.logo,
    name: payload.data.name,
    description: payload.data.description,
    inviter_reward: parseToken(payload.data.inviter_reward)[0],
    invited_reward: parseToken(payload.data.invited_reward)[0],

    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  // create community
  db.communities
    .insert(communityData)
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
      db.network
        .insert(networkData)
        .catch(e => {
          console.error('Something went wrong while adding community creator to network', e)
          Sentry.captureException(e)
        })
    })
    .catch(e => {
      console.error('Something went wrong while inserting a new community', e)
      Sentry.captureException(e)
    })
}

function updateCommunity (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Update community logo`)

  const [, symbol] = parseToken(payload.data.cmm_asset)

  const updateData = {
    symbol: symbol,
    creator: payload.data.creator,
    logo: payload.data.logo,
    name: payload.data.name,
    description: payload.data.description,
    inviter_reward: parseToken(payload.data.inviter_reward)[0],
    invited_reward: parseToken(payload.data.invited_reward)[0]
  }

  // Find the community
  db.communities
    .update({
      symbol: symbol
    }, updateData)
    .catch(e => {
      console.error('Something went wrong while updating community logo', e)
      Sentry.captureException(e)
    })
}

function netlink (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Netlink`)

  // Check if user isn't already created
  db.users
    .count({
      account: payload.data.new_user
    })
    .then(total => {
      const profileData = {
        account: payload.data.new_user,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      }

      if (total === '0') {
        db.users
          .insert(profileData)
          .catch(e => {
            console.error('Something went wrong while inserting user', e)
            Sentry.captureException(e)
          })
      }
    })
    .then(() => {
      const [, symbol] = parseToken(payload.data.cmm_asset)

      const networkData = {
        community_id: symbol,
        account_id: payload.data.new_user,
        invited_by_id: payload.authorization[0].actor,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      }

      db.network
        .insert(networkData)
        .catch(e => {
          console.error('Something went wrong while adding user to network table', e)
          Sentry.captureException(e)
        })
    })
    .catch(e => {
      console.error('Something went wrong while counting for existing users', e)
      Sentry.captureException(e)
    })
}

function createSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Sale`)

  const [price, symbol] = parseToken(payload.data.quantity)

  const data = {
    community_id: symbol,
    title: payload.data.title,
    description: payload.data.description,
    price: price,
    rate: 0,
    image: payload.data.image,
    units: payload.data.units,
    is_buy: payload.data.is_buy === 1,
    creator_id: payload.data.from,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  db.sales
    .insert(data)
    .catch(e => {
      console.error('Something went wrong while updating transfer data', e)
      Sentry.captureException(e)
    })
}

function transferSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Transfer Sale`)

  const [amount, symbol] = parseToken(payload.data.quantity)

  db.withTransaction(tx => {
    // Find Sale
    return tx.sales
      .findOne(payload.data.id)
      .then(sale => {
        // Decrease units
        const updateData = {
          units: sale.units - parseInt(payload.data.units)
        }

        tx.sales
          .update({
            id: sale.id
          }, updateData)
          .catch(e => {
            console.error('Something went wrong while updating sale units', e)
            Sentry.captureException(e)
          })

        // Insert payload into sale_history
        const insertData = {
          sale_id: payload.data.id,
          from_id: payload.data.from,
          to_id: payload.data.to,
          amount: amount,
          units: payload.data.units,
          community_id: symbol
        }

        tx.sale_history
          .insert(insertData)
          .catch(e => {
            console.error('Something went wrong while updating sale units', e)
            Sentry.captureException(e)
          })
      })
      .catch(e => {
        console.error('Something went wrong while looking for the sale', e)
        Sentry.captureException(e)
      })
  })
}

function newObjective (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Objective`)

  const [, symbol] = parseToken(payload.data.cmm_asset)

  // Add to objective table
  const objectiveData = {
    community_id: symbol,
    creator_id: payload.data.creator,
    description: payload.data.description,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  db.community_objectives
    .insert(objectiveData)
    .catch(e => {
      console.error('Something went wrong creating objective', e)
      Sentry.captureException(e)
    })
}

function newAction (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Objective Action`)

  const [rewardAmount] = parseToken(payload.data.reward)
  const [verifierAmount] = parseToken(payload.data.verifier_reward)

  const data = {
    community_objective_id: parseInt(payload.data.objective_id) + 1,
    creator_id: payload.data.creator,
    description: payload.data.description,
    reward: rewardAmount,
    verifier_reward: verifierAmount,
    is_verified: false,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  db.community_objective_actions
    .insert(data)
    .catch(e => {
      console.error('Something went wrong creating objective', e)
      Sentry.captureException(e)
    })
}

function verifyAction (db, payload, blockInfo, context) {}

module.exports = {
  createCommunity,
  updateCommunity,
  netlink,
  newObjective,
  newAction,
  verifyAction,
  createSale,
  transferSale
}
