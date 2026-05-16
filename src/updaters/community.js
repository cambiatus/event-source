const { logError } = require('../logging')
const {
  getSymbolFromAsset,
  parseToken
} = require('../eos_helper')

async function createCommunity(db, payload, blockInfo) {
  console.log(`Cambiatus >>> Create Community`, blockInfo.blockNumber)

  const symbol = getSymbolFromAsset(payload.data.cmm_asset)

  const transaction = async tx => {
    const subdomains = await tx.subdomains.find({ name: payload.data.subdomain })
    let subdomain
    if (subdomains.length === 0) {
      subdomain = await tx.subdomains.insert({ name: payload.data.subdomain, inserted_at: new Date(), updated_at: new Date() })
    } else {
      console.log('Trying to create a new community with a subdomain, skipping')
      subdomain = null
    }

    const communityData = {
      symbol: symbol,
      creator: payload.data.creator,
      logo: payload.data.logo || null,
      name: payload.data.name,
      description: payload.data.description || null,
      inviter_reward: parseToken(payload.data.inviter_reward)[0],
      invited_reward: parseToken(payload.data.invited_reward)[0],
      has_objectives: payload.data.has_objectives === 1,
      has_shop: payload.data.has_shop === 1,
      has_kyc: payload.data.has_kyc === 1,
      auto_invite: payload.data.auto_invite === 1,
      subdomain_id: subdomain?.id,
      website: payload.data.website || null,
      created_block: blockInfo.blockNumber,
      created_tx: payload.transactionId,
      created_eos_account: payload.authorization[0].actor,
      created_at: blockInfo.timestamp
    }

    const _community = await tx.communities.insert(communityData)

    const role = await tx.roles.insert({
      community_id: symbol,
      name: 'member',
      permissions: '{"invite", "claim", "order", "sell", "transfer"}',
      inserted_at: new Date(),
      updated_at: new Date()
    })

    const network = await tx.network.insert({
      community_id: symbol,
      account_id: payload.data.creator,
      invited_by_id: payload.data.creator,
      created_block: blockInfo.blockNumber,
      created_tx: payload.transactionId,
      created_eos_account: payload.authorization[0].actor,
      created_at: blockInfo.timestamp
    })

    return tx.network_roles.insert({
      network_id: network.id,
      role_id: role.id,
      inserted_at: new Date(),
      updated_at: new Date()
    })
  }

  return db.withTransaction(transaction).catch(err => logError('Something wrong while creating community data', err))
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
      logo: payload.data.logo || null,
      name: payload.data.name,
      description: payload.data.description || null,
      inviter_reward: parseToken(payload.data.inviter_reward)[0],
      invited_reward: parseToken(payload.data.invited_reward)[0],
      has_objectives: payload.data.has_objectives === 1,
      has_shop: payload.data.has_shop === 1,
      has_kyc: payload.data.has_kyc === 1,
      auto_invite: payload.data.auto_invite === 1,
      subdomain_id: subdomain.id,
      website: payload.data.website || null
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

async function netlink(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> New Netlink`, blockInfo.blockNumber)

  const countUsers = await db.users.count({ account: payload.data.new_user })

  // Check if user isn't already created
  if (countUsers === '0') {
    try {
      await db.users.insert({
        account: payload.data.new_user,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      })
    } catch (e) {
      logError('Something went wrong while inserting user', e)
    }
  }

  const countNetwork = await db.network.count({
    community_id: payload.data.community_id,
    account_id: payload.data.new_user
  })

  // if it contains at least one entry, finish the execution
  if (countNetwork !== '0') return

  // Try inserting network and roles
  try {
    const network = await db.network.insert({
      community_id: payload.data.community_id,
      account_id: payload.data.new_user,
      invited_by_id: payload.data.inviter,
      created_block: blockInfo.blockNumber,
      created_tx: payload.transactionId,
      created_eos_account: payload.authorization[0].actor,
      created_at: blockInfo.timestamp
    })

    const role = await db.roles.findOne({ community_id: payload.data.community_id, name: 'member' })
    if (role == null) throw new Error("Can't find role")

    const networkRoleData = {
      network_id: network.id,
      role_id: role.id,
      inserted_at: new Date(),
      updated_at: new Date()
    }

    await db.network_roles.insert(networkRoleData)
  } catch (error) {
    logError('Something went wrong while trying to insert user and its role to the network', error)
  }
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

      if (sale.track_stock) {
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

function upsertObjective(db, payload, blockInfo, _context) {
  console.log(`Cambiatus >>> Upsert Objective`, blockInfo.blockNumber)

  let data = {
    community_id: payload.data.community_id,
    creator_id: payload.data.editor,
    description: payload.data.description,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_at: blockInfo.timestamp,
    created_eos_account: payload.authorization[0].actor
  }

  if (payload.data.objective_id > 0) {
    data = Object.assign(data, { id: payload.data.objective_id })
  }

  db.objectives
    .save(data)
    .catch(e =>
      logError('Something went wrong while updating objective', e)
    )
}

async function upsertAction(db, payload, blockInfo, _context) {
  console.log(`Cambiatus >>> Upsert Action`, blockInfo.blockNumber)

  const [rewardAmount] = parseToken(payload.data.reward)
  const [verifierAmount] = parseToken(payload.data.verifier_reward)
  const deadlineDateTime = new Date(parseInt(payload.data.deadline))
  const validators =
    payload.data.validators_str.length > 0
      ? payload.data.validators_str.split('-')
      : []

  const o = await db.objectives.findOne({ id: payload.data.objective_id })
  if (o === null) {
    console.error(`Objective with the id ${payload.data.objective_id} does not exist`)
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
    photo_proof_instructions: payload.data.photo_proof_instructions || null,
    image: payload.data.image || null
  }

  if (payload.data.action_id > 0) {
    data = Object.assign(data, {
      id: payload.data.action_id,
      usages_left: payload.data.usages_left,
      is_completed: payload.data.is_completed === 1
    })
  }

  return db.withTransaction(async tx => {
    const savedAction = await tx.actions.save(data)

    if (payload.data.action_id > 0) {
      await tx.validators.destroy({ action_id: payload.data.action_id })
    }

    await Promise.all(validators.map(validator => {
      return tx.validators.insert({
        action_id: savedAction.id,
        validator_id: validator,
        created_block: blockInfo.blockNumber,
        created_tx: payload.transactionId,
        created_eos_account: payload.authorization[0].actor,
        created_at: blockInfo.timestamp
      })
    }))
  }).catch(e => logError('Something went wrong while executing transaction to create an action', e))
}

async function reward(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Action reward`, blockInfo.blockNumber)

  const a = await db.actions.findOne(payload.data.action_id)
    .catch(e => { logError('Something went wrong while finding an action', e) })
  if (a === null || a == null) throw new Error('action not available')

  const rewardInsert = db.rewards.save({
    action_id: a.id,
    receiver_id: payload.data.receiver,
    awarder_id: payload.data.awarder,
    inserted_at: new Date(),
    updated_at: new Date()
  }).catch(e => logError('Cant insert reward data', e))

  if (a.usages > 0) {
    const completed = a.usages_left - 1 <= 0
    const actionUpdate = db.actions.update({ id: payload.data.action_id }, {
      usages_left: a.usages_left - 1,
      is_completed: completed
    }).catch(e => logError('Something went wrong while verifying an action', e))

    return Promise.all([rewardInsert, actionUpdate])
  }

  return rewardInsert
}

function claimAction(db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Claim an Action`, blockInfo.blockNumber)

  const data = {
    action_id: payload.data.action_id,
    claimer_id: payload.data.maker,
    status: 'pending',
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp,
    proof_photo: payload.data.proof_photo || null,
    proof_code: payload.data.proof_code || null
  }

  db.claims
    .insert(data)
    .catch(e => logError('Something went wrong while inserting a claim', e))
}

async function verifyClaim(db, payload, blockInfo, context) {
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

  return db.withTransaction(async tx => {
    const check = await tx.checks.insert(checkData)

    const claim = await tx.claims.findOne(check.claim_id)
    console.log(`Cambiatus >>> Claim Verification: starting updating claims with id #${check.claim_id}`)
    if (claim === null) throw new Error('claim not available')

    const action = await tx.actions.findOne(claim.action_id)
    if (action === null) throw new Error('action not available')

    const [positiveVotes, negativeVotes] = await Promise.all([
      tx.checks.count({ claim_id: claim.id, is_verified: true }),
      tx.checks.count({ claim_id: claim.id, is_verified: false })
    ])

    const positive = Number(positiveVotes)
    const negative = Number(negativeVotes)
    console.log(`Cambiatus >>> Claim Verification: Positive votes: ${positiveVotes}`)
    console.log(`Cambiatus >>> Claim Verification: Negative votes: ${negativeVotes}`)

    const majority = (action.verifications >> 1) + (action.verifications & 1)

    let status = 'pending'
    if (positive >= majority || negative >= majority) {
      status = positive > negative ? 'approved' : 'rejected'
    }

    await tx.claims.update(claim.id, { status: status })
    console.log(`Cambiatus >>> Claim Verification: Status Updated to: ${status}`)

    if (status !== 'pending' && !action.is_completed && action.usages > 0) {
      await tx.actions.update(action.id, {
        usages_left: action.usages_left - 1,
        is_completed: (action.usages_left - 1) === 0
      }).catch(e => logError('Setting action as completed failed', e))
    }
  }).catch(e => logError('Something went wrong while inserting a check', e))
}

function upsertRole(db, payload, blockInfo, _context) {
  console.log(`Cambiatus >>> Upsert Role`, blockInfo.blockNumber)

  let roleData = {
    community_id: payload.data.community_id,
    name: payload.data.name,
    color: payload.data.color,
    permissions: '{' + payload.data.permissions.map(p => `"${p}"`).join(", ") + '}',
    inserted_at: new Date(),
    updated_at: new Date()
  }

  db.roles.findOne({ name: payload.data.name, community_id: payload.data.community_id })
    .then(existingRole => {
      if (existingRole != null) {
        roleData = Object.assign(roleData, { id: existingRole.id })
      }

      return db.roles.save(roleData)
    })
    .catch(error => {
      logError('Something went wrong while updating role', error)

    })
}

async function assignRole(db, payload, blockInfo, _context) {
  console.log('Cambiatus >>> Assign Role', blockInfo.blockNumber)

  const [foundNetwork, foundRoles] = await Promise.all([
    db.network.findOne({ community_id: payload.data.community_id, account_id: payload.data.member }),
    db.roles.find({ community_id: payload.data.community_id, name: payload.data.roles })
  ])

  if (foundNetwork == null)
    throw new Error('Network not found. Might have a database sync error')

  const rolesByName = Object.fromEntries(foundRoles.map(r => [r.name, r]))
  const inserts = payload.data.roles.map(roleName => {
    const foundRole = rolesByName[roleName]
    if (foundRole == null)
      throw new Error('Role not found. Might have a database sync error')
    return {
      network_id: foundNetwork.id,
      role_id: foundRole.id,
      inserted_at: new Date(),
      updated_at: new Date()
    }
  })

  return db.withTransaction(async tx => {
    await tx.network_roles.destroy({ network_id: foundNetwork.id })
    await Promise.all(inserts.map(data => tx.network_roles.insert(data)))
  }).catch(error => logError('Something went wrong while trying to delete and assign roles to an user', error))
}

module.exports = {
  createCommunity,
  updateCommunity,
  netlink,
  upsertObjective,
  upsertAction,
  reward,
  transferSale,
  verifyClaim,
  claimAction,
  upsertRole,
  assignRole
}
