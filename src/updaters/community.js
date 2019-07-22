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

  const data = {
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
    created_at: blockInfo.timestamp
  }

  // Insert sale on database
  db.sales
    .insert(data)
    .catch(logError('Something went wrong while creating a new sale'))
}

function updateSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Update sale`)

  const [price] = parseToken(payload.data.quantity)

  // Update sale data
  const updateData = {
    title: payload.data.title,
    description: payload.data.description,
    price: price,
    image: payload.data.image,
    units: payload.data.units
  }

  db.sales
    .update({
      id: payload.data.sale_id,
      is_deleted: false
    }, updateData)
    .catch(logError('Something went wrong while updating sale, make sure that sale is not deleted'))
}

function deleteSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Remove sale`)

  // Soft delete sale
  const updateData = {
    is_deleted: true,
    deleted_at: blockInfo.timestamp
  }

  db.sales
    .update({
      id: payload.data.sale_id,
      is_deleted: false
    }, updateData)
    .catch(logError('Something went wrong while removing sale, make sure that sale is not deleted'))
}

function reactSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Vote in a sale`)

  const transaction = (tx) => {
    // Find sale
    tx.sales
      .findOne({
        id: payload.data.sale_id,
        is_deleted: false
      })
      .then(sale => {
        if (sale === null) {
          throw new Error('No data available')
        }

        const whereArg = {
          sale_id: sale.id,
          account_id: payload.data.from
        }

        // Check if sale was previously voted
        tx.sale_ratings
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

              tx.sale_ratings
                .insert(data)
            } else {
              const updateData = {
                rating: payload.data.type
              }

              tx.sale_ratings
                .update(whereArg, updateData)
            }
          })
      })
  }

  db.withTransaction(transaction)
    .catch(logError('Something went wrong while reacting to a sale, make sure that sale is not deleted'))
}

function transferSale (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Transfer Sale`)

  const transaction = (tx) => {
    const [amount, symbol] = parseToken(payload.data.quantity)

    const whereArg = {
      id: payload.data.sale_id,
      is_deleted: false
    }

    // Find sale
    return tx.sales
      .findOne(whereArg)
      .then(sale => {
        if (sale === null) {
          throw new Error('No data available')
        }

        // Update sale units
        const updateData = {
          units: sale.units - parseInt(payload.data.units)
        }

        tx.sales
          .update(whereArg, updateData)

        // Insert new sale transfer history
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
      })
  }

  db.withTransaction(transaction)
    .catch(logError('Something went wrong while transferring sale'))
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

  db.objectives
    .insert(objectiveData)
    .catch(logError('Something went wrong creating objective'))
}

function newAction (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Objective Action`)

  const [rewardAmount] = parseToken(payload.data.reward)
  const [verifierAmount] = parseToken(payload.data.verifier_reward)
  const deadlineDateTime = new Date(payload.data.deadline * 1000).toISOString()
  const validators = payload.data.validators_str.split('-')

  const data = {
    objective_id: payload.data.objective_id,
    creator_id: payload.data.creator,
    description: payload.data.description,
    reward: rewardAmount,
    verifier_reward: verifierAmount,
    is_completed: false,
    usages: payload.data.usages,
    usages_left: payload.data.usages,
    verifications: payload.data.verifications,
    verification_type: payload.data.verification_type,
    deadline: deadlineDateTime,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  db.withTransaction(tx => {
    return tx.actions
      .insert(data)
      .then(savedAction => {
        validators.map(v => {
          const validatorData = {
            action_id: savedAction.id,
            validator_id: v,
            created_block: blockInfo.blockNumber,
            created_tx: payload.transactionId,
            created_eos_account: payload.authorization[0].actor,
            created_at: blockInfo.timestamp
          }

          tx.validators
            .insert(validatorData)
        })
      })
  })
    .catch(logError('Something went wrong while creating an action'))
}

function verifyAction (db, payload, blockInfo, context) {
  console.log(`BeSpiral  >>> Action verification`)

  // Collect the action
  db.actions
    .findOne(payload.data.action_id)
    .then(a => {
      if (a === null) {
        throw new Error('action not available')
      }

      const completed = a.usages_left - 1 <= 0

      const updateData = {
        usages_left: a.usages_left - 1,
        is_completed: completed
      }

      db.actions
        .update({
          id: payload.data.action_id
        }, updateData)
        .catch(logError('Something went wrong while verifying an action'))
    })
    .catch(logError('Something went wrong while finding an action'))
}

function claimAction (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Claiming an Action`)

  const data = {
    action_id: payload.data.action_id,
    claimer_id: payload.data.claimer,
    is_verified: false,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  db.claims
    .insert(data)
    .catch(logError('Something went wrong while inserting a claim'))
}

function verifyClaim (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Claim Verification`)

  const checkData = {
    claim_id: payload.data.claim_id,
    validator_id: payload.data.validator,
    is_verified: payload.data.vote === 1,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  db.withTransaction(tx => {
    return tx.checks
      .insert(checkData)
    // Save the Check
      .then(check => {
        tx.claims
        // Find the checks claim
          .findOne(check.claim_id)
          .then(claim => {
            if (claim === null) {
              throw new Error('claim not available')
            }
            tx.actions
            // Find the claims action
              .findOne(claim.action_id)
            // Count verified checks
              .then(action => {
                if (action === null) {
                  throw new Error('action not available')
                }

                tx.checks
                  .count({
                    claim_id: claim.id,
                    is_verified: true
                  })
                  .then(total => {
                    // Set claim as completed
                    if (Number(total) >= action.verifications) {
                      tx.claims
                        .update(claim.id, { is_verified: true })
                    }

                    const updateData = {
                      usages_left: action.usages_left - 1,
                      is_completed: action.usages > 0 && (action.usages_left - 1 <= 0)
                    }

                    tx.actions
                      .update(action.id, updateData)
                  })
              })
          })
      })
  })
    .catch(logError('Something went wrong while inserting a check'))
}

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
  reactSale,
  transferSale,
  verifyClaim,
  claimAction
}
