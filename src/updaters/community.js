const { logError } = require('../logging')
const {
  getSymbolFromAsset,
  parseToken
} = require('../eos_helper')

function createCommunity(db, payload, blockInfo) {
  console.log(`Cambiatus >>> Create Community`, blockInfo.blockNumber)

  const symbol = getSymbolFromAsset(payload.data.cmm_asset)

  const transaction = async tx => {
    // Upsert new domain existing subdomain
    const subdomains = await tx.subdomains.find({ name: payload.data.subdomain })
    const subdomainId = await (async () => {
      if (subdomains.length === 0) {
        const newSubdomain = await tx.subdomains.insert({ name: payload.data.subdomain, inserted_at: new Date(), updated_at: new Date() })
        return newSubdomain.id
      } else {
        console.log('Trying to create a new community with a subdomain, skipping')
        return null
      }
    })()

    const communityData = {
      symbol: symbol,
      creator: payload.data.creator,
      logo: payload.data.logo,
      name: payload.data.name,
      description: payload.data.description,
      inviter_reward: parseToken(payload.data.inviter_reward)[0],
      invited_reward: parseToken(payload.data.invited_reward)[0],
      has_objectives: payload.data.has_objectives === 1,
      has_shop: payload.data.has_shop === 1,
      has_kyc: payload.data.has_kyc === 1,
      auto_invite: payload.data.auto_invite === 1,
      subdomain_id: subdomainId,
      website: payload.data.website,
      created_block: blockInfo.blockNumber,
      created_tx: payload.transactionId,
      created_eos_account: payload.authorization[0].actor,
      created_at: blockInfo.timestamp
    }

    // create community
    tx.communities
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
        tx.network
          .insert(networkData)
          .catch(e =>
            logError(
              'Something went wrong while adding community creator to network',
              e
            )
          )
      })
      .catch(e =>
        logError('Something went wrong while inserting a new community', e)
      )
  }

  db.withTransaction(transaction).catch(err => logError('Something wrong while creating community data', err))
}

async function updateCommunity(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Update community logo`, blockInfo.blockNumber)

  const symbol = getSymbolFromAsset(payload.data.cmm_asset)

  // Check if we can free up the old community subdomain
  const oldCommunity = await db.communities.findOne({ symbol: symbol })

  const transaction = async tx => {
    // Upsert new domain existing subdomain
    const subdomains = await tx.subdomains.find({ name: payload.data.subdomain })
    const subdomain = await (async () => {
      if (subdomains.length === 0) {
        return tx.subdomains.insert({ name: payload.data.subdomain, inserted_at: new Date(), updated_at: new Date() })
      } else {
        return subdomains[0]
      }
    })()

    const updateData = {
      symbol: symbol,
      logo: payload.data.logo,
      name: payload.data.name,
      description: payload.data.description,
      inviter_reward: parseToken(payload.data.inviter_reward)[0],
      invited_reward: parseToken(payload.data.invited_reward)[0],
      has_objectives: payload.data.has_objectives === 1,
      has_shop: payload.data.has_shop === 1,
      has_kyc: payload.data.has_kyc === 1,
      auto_invite: payload.data.auto_invite === 1,
      subdomain_id: subdomain.id,
      website: payload.data.website
    }

    // Find the community
    tx.communities
      .update({ symbol: symbol }, updateData)
      .catch(e =>
        logError('Something went wrong while updating community', e)
      )

    return subdomain.id
  }
  const newSubdomainId = await db.withTransaction(transaction).catch(err => logError('Something wrong while updating community data', err))

  if (oldCommunity.subdomain_id !== Number(newSubdomainId)) {
    await db.reload()
    db.subdomains.destroy(oldCommunity.subdomain_id)
  }
}

function netlink(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> New Netlink`, blockInfo.blockNumber)

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
          .catch(e => logError('Something went wrong while inserting user', e))
      }
    })
    .then(() => {
      const symbol = getSymbolFromAsset(payload.data.cmm_asset)

      const networkData = {
        community_id: symbol,
        account_id: payload.data.new_user,
        invited_by_id: payload.data.inviter,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      }

      // Check if user don't already belong to the community
      db.network
        .count({
          community_id: symbol,
          account_id: payload.data.new_user
        })
        .then(networkTotal => {
          if (networkTotal !== '0') {
            return
          }

          db.network
            .insert(networkData)
            .catch(e =>
              logError(
                'Something went wrong while adding user to network table',
                e
              )
            )
        })
        .catch(e =>
          logError(
            'Something went wrong while trying to insert user to the network',
            e
          )
        )
    })
    .catch(e =>
      logError('Something went wrong while counting for existing users', e)
    )
}

function createSale(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> New Sale`, blockInfo.blockNumber)

  const [price] = parseToken(payload.data.quantity)
  const symbol = getSymbolFromAsset(payload.data.quantity)
  const trackStock = payload.data.track_stock === 1
  const units = trackStock ? payload.data.units : 0

  const data = {
    community_id: symbol,
    title: payload.data.title,
    description: payload.data.description,
    price: price,
    image: payload.data.image == "" ? null : payload.data.image,
    units: units,
    track_stock: trackStock,
    is_deleted: false,
    creator_id: payload.data.from,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  // Insert sale on database
  db.products
    .insert(data)
    .catch(e => logError('Something went wrong while creating a new sale', e))
}

function updateSale(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Update sale`, blockInfo.blockNumber)

  const whereArg = {
    id: payload.data.sale_id,
    is_deleted: false
  }

  db.products
    .findOne(whereArg)
    .then(sale => {
      if (sale == null) {
        throw new Error('No sale data available')
      }

      const [price] = parseToken(payload.data.quantity)
      const units = payload.data.track_stock === 1 ? payload.data.units : 0
      const trackStock = payload.data.track_stock === 1

      // Update sale data
      const updateData = {
        title: payload.data.title,
        description: payload.data.description,
        price: price,
        image: payload.data.image == "" ? null : payload.data.image,
        track_stock: trackStock,
        units: units
      }

      db.products
        .update(whereArg, updateData)
        .catch(e =>
          logError(
            'Something went wrong while updating sale, make sure that sale is not deleted',
            e
          )
        )
    })
    .catch(e =>
      logError(
        'Something went wrong while looking for the sale, make sure that sale is not deleted',
        e
      )
    )
}

function deleteSale(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Remove sale`, blockInfo.blockNumber)

  // Soft delete sale
  const updateData = {
    is_deleted: true,
    deleted_at: blockInfo.timestamp
  }

  db.products
    .update(
      {
        id: payload.data.sale_id,
        is_deleted: false
      },
      updateData
    )
    .catch(e =>
      logError(
        'Something went wrong while removing sale, make sure that sale is not deleted',
        e
      )
    )
}

function reactSale(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Vote in a sale`, blockInfo.blockNumber)

  const transaction = tx => {
    // Find sale
    tx.products
      .findOne({
        id: payload.data.sale_id,
        is_deleted: false
      })
      .then(sale => {
        if (sale === null) {
          throw new Error('No sale data available')
        }

        const whereArg = {
          product_id: sale.id,
          account_id: payload.data.from
        }

        // Check if sale was previously voted
        tx.sale_ratings.count(whereArg).then(total => {
          if (total === '0') {
            const data = {
              product_id: sale.id,
              account_id: payload.data.from,
              rating: payload.data.type,
              created_block: blockInfo.blockNumber,
              created_tx: payload.transactionId,
              created_eos_account: payload.authorization[0].actor,
              created_at: blockInfo.timestamp
            }

            tx.sale_ratings.insert(data)
          } else {
            const updateData = {
              rating: payload.data.type
            }

            tx.sale_ratings.update(whereArg, updateData)
          }
        })
      })
  }

  db.withTransaction(transaction).catch(e =>
    logError(
      'Something went wrong while reacting to a sale, make sure that sale is not deleted',
      e
    )
  )
}

function transferSale(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> New Transfer Sale`, blockInfo.blockNumber)

  const transaction = tx => {
    const [amount] = parseToken(payload.data.quantity)
    const symbol = getSymbolFromAsset(payload.data.quantity)

    const whereArg = {
      id: payload.data.sale_id,
      is_deleted: false
    }

    // Find sale
    return tx.products.findOne(whereArg).then(sale => {
      if (sale === null) {
        throw new Error('No sale data available')
      }

      if (sale.trackStock) {
        const newUnits = sale.units - parseInt(payload.data.units)

        // Update sale units
        const updateData = {
          units: (newUnits <= 0) ? 0 : newUnits
        }

        tx.products.update(whereArg, updateData)
      }

      // Insert new order
      const insertData = {
        product_id: sale.id,
        from_id: payload.data.from,
        to_id: payload.data.to,
        amount: amount,
        units: payload.data.units,
        community_id: symbol,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_at: blockInfo.timestamp,
        created_eos_account: payload.authorization[0].actor
      }

      tx.orders.insert(insertData)
    })
  }

  db.withTransaction(transaction).catch(e =>
    logError('Something went wrong while transferring sale', e)
  )
}

function newObjective(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> New Objective`, blockInfo.blockNumber)

  const symbol = getSymbolFromAsset(payload.data.cmm_asset)

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
    .catch(e => logError('Something went wrong creating objective', e))
}

function updateObjective(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Update Objective`, blockInfo.blockNumber)

  const where = { id: payload.data.objective_id }

  db.objectives
    .findOne(where)
    .then(obj => {
      if (obj == null) {
        throw new Error('No objective found in the database')
      }

      const updateData = {
        description: payload.data.description
      }

      db.objectives
        .update(where, updateData)
        .catch(e =>
          logError('Something went wrong while updating objective', e)
        )
    })
    .catch(e =>
      logError('Something went wrong while looking for the objective', e)
    )
}

function upsertAction(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Upsert Action`, blockInfo.blockNumber)

  const [rewardAmount] = parseToken(payload.data.reward)
  const [verifierAmount] = parseToken(payload.data.verifier_reward)
  const deadlineDateTime = new Date(parseInt(payload.data.deadline))
  const validators =
    payload.data.validators_str.length > 0
      ? payload.data.validators_str.split('-')
      : []

  db.objectives.findOne({ id: payload.data.objective_id }).then(o => {
    if (o === null) {
      console.error(
        `Objective with the id ${payload.data.objective_id} does not exist`
      )
      return
    }

    let data = {
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
      deadline: payload.data.deadline > 0 ? deadlineDateTime : null,
      created_block: blockInfo.blockNumber,
      created_tx: payload.transactionId,
      created_at: blockInfo.timestamp,
      created_eos_account: payload.authorization[0].actor,
      has_proof_photo: payload.data.has_proof_photo === 1,
      has_proof_code: payload.data.has_proof_code === 1,
      photo_proof_instructions: payload.data.photo_proof_instructions
    }

    if (payload.data.action_id > 0) {
      // Update
      data = Object.assign(data, {
        id: payload.data.action_id,
        usages_left: payload.data.usages_left,
        is_completed: payload.data.is_completed === 1
      })
    }

    db.withTransaction(tx => {
      return tx.actions
        .save(data)
        .then(savedAction => {
          // In case of a update delete all older validators and add new ones
          if (payload.data.action_id > 0) {
            db.validators
              .destroy({ action_id: payload.data.action_id })
              .catch(e =>
                logError(
                  'Something went wrong while deleting old validators',
                  e
                )
              )
          }

          validators.map(validator => {
            const validatorData = {
              action_id: savedAction.id,
              validator_id: validator,
              created_block: blockInfo.blockNumber,
              created_tx: payload.transactionId,
              created_eos_account: payload.authorization[0].actor,
              created_at: blockInfo.timestamp
            }

            tx.validators
              .insert(validatorData)
              .catch(e =>
                logError(
                  'Something went wrong while adding a validator to the list',
                  e
                )
              )
          })
        })
        .catch(e => logError('Error while creating an action', e))
    }).catch(e =>
      logError(
        'Something went wrong while executing transaction to create an action',
        e
      )
    )
  })
}

function verifyAction(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Action verification`, blockInfo.blockNumber)

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
        .update(
          {
            id: payload.data.action_id
          },
          updateData
        )
        .catch(e =>
          logError('Something went wrong while verifying an action', e)
        )
    })
    .catch(e => logError('Something went wrong while finding an action', e))
}

function claimAction(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Claiming an Action`, blockInfo.blockNumber)

  const data = {
    action_id: payload.data.action_id,
    claimer_id: payload.data.maker,
    status: 'pending',
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp,
    proof_photo: payload.data.proof_photo,
    proof_code: payload.data.proof_code
  }

  db.claims
    .insert(data)
    .catch(e => logError('Something went wrong while inserting a claim', e))
}

function verifyClaim(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Claim Verification`, blockInfo.blockNumber)

  const checkData = {
    claim_id: payload.data.claim_id,
    validator_id: payload.data.verifier,
    is_verified: payload.data.vote === 1,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  db.withTransaction(tx => {
    // Save the Check
    return tx.checks.insert(checkData).then(check => {
      // Find the checks claim
      tx.claims.findOne(check.claim_id).then(claim => {
        console.log(`Cambiatus >>> Claim Verification: starting updating claims with id #${check.claim_id}`)

        if (claim === null) {
          throw new Error('claim not available')
        }

        // Find the claims action
        tx.actions.findOne(claim.action_id).then(action => {
          if (action === null) {
            throw new Error('action not available')
          }

          // Count positive votes
          tx.checks
            .count({ claim_id: claim.id, is_verified: true })
            .then(positiveVotes => {
              const positive = Number(positiveVotes)
              console.log(`Cambiatus >>> Claim Verification: Positive votes: ${positiveVotes}`)
              // Count negative votes
              tx.checks
                .count({ claim_id: claim.id, is_verified: false })
                .then(negativeVotes => {
                  const negative = Number(negativeVotes)
                  console.log(`Cambiatus >>> Claim Verification: Negative votes: ${negativeVotes}`)

                  const majority = (action.verifications >> 1) + (action.verifications & 1)

                  let status = 'pending'
                  if (positiveVotes >= majority || negativeVotes >= majority) {
                    if (positive > negative) {
                      status = 'approved'
                    } else {
                      status = 'rejected'
                    }
                  }

                  tx.claims.update(claim.id, { status: status })
                  console.log(`Cambiatus >>> Claim Verification: Status Updated to: ${status}`)

                  if (status !== 'pending') {
                    if (!action.is_completed && action.usages > 0) {
                      tx.actions.update(action.id, {
                        usages_left: action.usages_left - 1,
                        is_completed: (action.usages_left - 1) === 0
                      }).catch(e => logError('Setting action as completed failed', e))
                    }
                  }
                })
            })
        })
      })
    })
  }).catch(e => logError('Something went wrong while inserting a check', e))
}

module.exports = {
  createCommunity,
  updateCommunity,
  netlink,
  newObjective,
  updateObjective,
  upsertAction,
  verifyAction,
  createSale,
  updateSale,
  deleteSale,
  reactSale,
  transferSale,
  verifyClaim,
  claimAction
}
