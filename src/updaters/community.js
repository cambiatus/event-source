const {
  logError
} = require('../logging')
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
        .catch(logError('Something went wrong while adding community creator to network'))
    })
    .catch(logError('Something went wrong while inserting a new community'))
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
    .catch(logError('Something went wrong while updating community logo'))
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
          .catch(logError('Something went wrong while inserting user'))
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
        .catch(logError('Something went wrong while adding user to network table'))
    })
    .catch(logError('Something went wrong while counting for existing users'))
}

function createSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Sale`)

  const [price, symbol] = parseToken(payload.data.quantity)

  const content =
    payload.data.iso_datetime +
    payload.data.from +
    payload.data.title +
    payload.data.description

  const hash = toSha256(content)

  const data = {
    hash: hash,
    community_id: symbol,
    title: payload.data.title,
    description: payload.data.description,
    price: price,
    image: payload.data.image,
    units: payload.data.units,
    is_buy: payload.data.is_buy === 1,
    is_deleted: false,
    creator_id: payload.data.from,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp,
    requested_at: payload.data.iso_datetime
  }

  db.sales
    .insert(data)
    .catch(logError('Something went wrong while updating transfer data'))
}

function updateSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Update sale`)

  const [price] = parseToken(payload.data.quantity)

  const updateData = {
    title: payload.data.title,
    description: payload.data.description,
    price: price,
    image: payload.data.image,
    units: payload.data.units
  }

  db.sales
    .update({
      hash: payload.data.sale_hash,
      is_deleted: false
    }, updateData)
    .catch(logError('Something went wrong while updating sale, make sure that sale is not deleted'))
}

function deleteSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Remove sale`)

  const updateData = {
    is_deleted: true,
    deleted_at: blockInfo.timestamp
  }

  db.sales
    .update({
      hash: payload.data.sale_hash,
      is_deleted: false
    }, updateData)
    .catch(logError('Something went wrong while removing sale, make sure that sale is not deleted'))
}

function voteSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Vote in a sale`)

  db.sales
    .findOne({
      hash: payload.data.sale_hash,
      is_deleted: false
    })
    .then(sale => {
      if (sale == null) {
        logError('Something went wrong while updating sale units')
        return
      }

      const whereArg = {
        sale_id: sale.id,
        account_id: payload.data.from
      }

      db.sale_ratings
        .count(whereArg)
        .then(total => {
          if (total === '0') {
            const data = {
              sale_id: sale.id,
              account_id: payload.data.from,
              rating: payload.data.type,
              created_block: blockInfo.blockNumber,
              created_tx: payload.transactionId,
              created_eos_account: payload.authorization[0].actor,
              created_at: blockInfo.timestamp
            }

            db.sale_ratings
              .insert(data)
              .catch(logError('Something went wrong while inserting a vote'))
          } else {
            const updateData = {
              rating: payload.data.type
            }

            db.sale_ratings
              .update(whereArg, updateData)
              .catch(logError('Something went wrong while updating a vote'))
          }
        })
    })
    .catch(logError('Something went wrong while looking for the sale, make sure that sale is not deleted'))
}

function transferSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Transfer Sale`)

  const [amount, symbol] = parseToken(payload.data.quantity)

  const whereArg = {
    hash: payload.data.sale_hash,
    is_deleted: false
  }

  db.withTransaction(tx => {
    // Find Sale
    return tx.sales
      .findOne(whereArg)
      .then(sale => {
        if (sale == null) {
          logError('Something went wrong while updating sale units')
          return
        }

        // Decrease units
        const updateData = {
          units: sale.units - parseInt(payload.data.units)
        }

        tx.sales
          .update(whereArg, updateData)
          .catch(logError('Something went wrong while updating sale units, make sure that sale is not deleted'))

        // Insert payload into sale_history
        const insertData = {
          sale_id: sale.id,
          from_id: payload.data.from,
          to_id: payload.data.to,
          amount: amount,
          units: payload.data.units,
          community_id: symbol
        }

        tx.sale_history
          .insert(insertData)
          .catch(logError('Something went wrong while updating sale units'))
      })
      .catch(logError('Something went wrong while looking for the sale'))
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
    .catch(logError('Something went wrong creating objective'))
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
    .catch(logError('Something went wrong creating objective'))
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
  updateSale,
  deleteSale,
  voteSale,
  transferSale
}
