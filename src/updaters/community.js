const { logError } = require('../logging')
const {
  getSymbolFromAsset,
  parseToken
} = require('../eos_helper')

async function createCommunity (db, payload, blockInfo) {
  console.log(`Cambiatus >>> Create Community`, blockInfo.blockNumber)

  const symbol = getSymbolFromAsset(payload.data.cmm_asset)

  const existing = await db.communities.findOne({ symbol })
  if (existing) {
    console.log(`Cambiatus >>> Community ${symbol} already exists, skipping create`)
    return
  }

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
      logo: payload.data.logo === '' ? null : payload.data.logo,
      name: payload.data.name,
      description: payload.data.description === '' ? null : payload.data.description,
      inviter_reward: parseToken(payload.data.inviter_reward)[0],
      invited_reward: parseToken(payload.data.invited_reward)[0],
      has_objectives: payload.data.has_objectives === 1,
      has_shop: payload.data.has_shop === 1,
      has_kyc: payload.data.has_kyc === 1,
      auto_invite: payload.data.auto_invite === 1,
      subdomain_id: subdomainId,
      website: payload.data.website === '' ? null : payload.data.website,
      created_block: blockInfo.blockNumber,
      created_tx: payload.transactionId,
      created_eos_account: payload.authorization[0].actor,
      created_at: blockInfo.timestamp
    }

    // create community
    await tx.communities.insert(communityData)

    const roleData = {
      community_id: symbol,
      name: 'member',
      permissions: '{"invite", "claim", "order", "sell", "transfer"}',
      inserted_at: new Date(),
      updated_at: new Date()
    }

    const role = await tx.roles.insert(roleData)

    const networkData = {
      community_id: symbol,
      account_id: payload.data.creator,
      invited_by_id: payload.data.creator,
      created_block: blockInfo.blockNumber,
      created_tx: payload.transactionId,
      created_eos_account: payload.authorization[0].actor,
      created_at: blockInfo.timestamp
    }

    const network = await tx.network.insert(networkData)

    const networkRoleData = {
      network_id: network.id,
      role_id: role.id,
      inserted_at: new Date(),
      updated_at: new Date()
    }

    await tx.network_roles.insert(networkRoleData)
  }

  return db.withTransaction(transaction).catch(e => {
    logError('Something went wrong while creating community', e)
  })
}

async function updateCommunity (db, payload, blockInfo, context) {
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
      logo: payload.data.logo === '' ? null : payload.data.logo,
      name: payload.data.name,
      description: payload.data.description === '' ? 'Cambiatus Community' : payload.data.description,
      inviter_reward: parseToken(payload.data.inviter_reward)[0],
      invited_reward: parseToken(payload.data.invited_reward)[0],
      has_objectives: payload.data.has_objectives === 1,
      has_shop: payload.data.has_shop === 1,
      has_kyc: payload.data.has_kyc === 1,
      auto_invite: payload.data.auto_invite === 1,
      subdomain_id: subdomain.id,
      website: payload.data.website === '' ? null : payload.data.website
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

async function netlink (db, payload, blockInfo, context) {
  console.log('Cambiatus >>> New Netlink', blockInfo.blockNumber)

  // NOTE: this updater runs inside the block-level serializable transaction that
  // demux opens for every action of an on-chain tx (see handleWithState). We do NOT
  // swallow errors here: a failed join must roll back the whole block (including the
  // welcome issue/transfer) so we never commit a half-applied membership. All writes
  // use ON CONFLICT DO NOTHING so a retried/re-indexed block is idempotent.

  // Idempotent user insert — relies on the unique/PK on users.account
  await db.instance.none(
    `INSERT INTO users (account, created_block, created_tx, created_eos_account, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      payload.data.new_user,
      blockInfo.blockNumber,
      payload.transactionId,
      payload.authorization[0].actor,
      blockInfo.timestamp
    ]
  )

  // Idempotent membership insert — relies on the unique index on network(account_id, community_id).
  // RETURNING yields the new row's id only when a row was actually inserted; on conflict it
  // returns null, meaning the account is already a member and there is nothing left to do.
  const network = await db.instance.oneOrNone(
    `INSERT INTO network (community_id, account_id, invited_by_id, created_block, created_tx, created_eos_account, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      payload.data.community_id,
      payload.data.new_user,
      payload.data.inviter,
      blockInfo.blockNumber,
      payload.transactionId,
      payload.authorization[0].actor,
      blockInfo.timestamp
    ]
  )

  // Already a member — skip the role assignment
  if (network == null) return

  const role = await db.roles.findOne({ community_id: payload.data.community_id, name: 'member' })
  if (role == null) throw new Error(`netlink: 'member' role not found for community ${payload.data.community_id}`)

  await db.network_roles.insert({
    network_id: network.id,
    role_id: role.id,
    inserted_at: new Date(),
    updated_at: new Date()
  })
}

function transferSale (db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> New Transfer Sale`, blockInfo.blockNumber)

  const transaction = async tx => {
    const [amount] = parseToken(payload.data.quantity)
    const symbol = getSymbolFromAsset(payload.data.quantity)

    // Idempotency: a re-indexed block must not duplicate this order (and must not
    // decrement product stock twice). Bail out before touching units if an order for
    // this tx already exists. Keyed on (created_tx, from_id, product_id) — a re-indexed
    // copy is byte-identical, and a single buyer can't legitimately purchase the same
    // product twice in one tx, so this collapses true duplicates without dropping real
    // orders. Enforced at the DB level by orders_dedup_idx (backend migration).
    const existing = await tx.orders.count({
      created_tx: payload.transactionId,
      from_id: payload.data.from,
      product_id: payload.data.sale_id
    })
    if (Number(existing) > 0) return

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

function upsertObjective (db, payload, blockInfo, _context) {
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

function upsertAction (db, payload, blockInfo, _context) {
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
      photo_proof_instructions: payload.data.photo_proof_instructions === '' ? null : payload.data.photo_proof_instructions,
      image: payload.data.image === '' ? null : payload.data.image
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

function reward (db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Action reward`, blockInfo.blockNumber)

  // Collect the action
  db.actions
    .findOne(payload.data.action_id)
    .then(a => {
      if (a === null) {
        throw new Error('action not available')
      }

      // Update usages if thats the case of this automatic action
      if (a.usages > 0) {
        const completed = a.usages_left - 1 <= 0

        const updateData = {
          usages_left: a.usages_left - 1,
          is_completed: completed
        }

        db.actions
          .update({ id: payload.data.action_id }, updateData)
          .catch(e =>
            logError('Something went wrong while verifying an action', e)
          )
      }

      // Insert reward
      const data = {
        action_id: a.id,
        receiver_id: payload.data.receiver,
        awarder_id: payload.data.awarder,
        inserted_at: new Date(),
        updated_at: new Date()
      }

      db.rewards.save(data)
        .catch(e => logError('Cant insert reward data', e))
    })
    .catch(e => logError('Something went wrong while finding an action', e))
}

async function claimAction (db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Claim an Action`, blockInfo.blockNumber)

  // Idempotency: a re-indexed block must not duplicate this claim. Without this guard a
  // reindex re-inserts the claim as a fresh `pending` row with no checks, surfacing as a
  // duplicate that looks un-approved. Keyed on (created_tx, action_id, claimer_id) — a
  // single maker can't claim the same action twice in one tx, so this collapses true
  // duplicates without dropping real claims. Enforced at the DB level by claims_dedup_idx.
  const existing = await db.claims.count({
    created_tx: payload.transactionId,
    action_id: payload.data.action_id,
    claimer_id: payload.data.maker
  })
  if (Number(existing) > 0) return

  const data = {
    action_id: payload.data.action_id,
    claimer_id: payload.data.maker,
    status: 'pending',
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp,
    proof_photo: payload.data.proof_photo === '' ? null : payload.data.proof_photo,
    proof_code: payload.data.proof_code === '' ? null : payload.data.proof_code
  }

  await db.claims
    .insert(data)
    .catch(e => logError('Something went wrong while inserting a claim', e))
}

async function verifyClaim (db, payload, blockInfo, context) {
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

    if (claim === null) {
      throw new Error('claim not available')
    }

    const action = await tx.actions.findOne(claim.action_id)
    if (action === null) {
      throw new Error('action not available')
    }

    const positiveVotes = Number(await tx.checks.count({ claim_id: claim.id, is_verified: true }))
    console.log(`Cambiatus >>> Claim Verification: Positive votes: ${positiveVotes}`)

    const negativeVotes = Number(await tx.checks.count({ claim_id: claim.id, is_verified: false }))
    console.log(`Cambiatus >>> Claim Verification: Negative votes: ${negativeVotes}`)

    const majority = (action.verifications >> 1) + (action.verifications & 1)

    let status = 'pending'
    if (positiveVotes >= majority || negativeVotes >= majority) {
      status = positiveVotes > negativeVotes ? 'approved' : 'rejected'
    }

    await tx.claims.update(claim.id, { status: status })
    console.log(`Cambiatus >>> Claim Verification: Status Updated to: ${status}`)

    if (status !== 'pending' && !action.is_completed && action.usages > 0) {
      await tx.actions.update(action.id, {
        usages_left: action.usages_left - 1,
        is_completed: (action.usages_left - 1) === 0
      })
    }
  }).catch(e => logError('Something went wrong while inserting a check', e))
}

async function upsertRole (db, payload, blockInfo, _context) {
  console.log(`Cambiatus >>> Upsert Role`, blockInfo.blockNumber)

  let roleData = {
    community_id: payload.data.community_id,
    name: payload.data.name,
    color: payload.data.color,
    permissions: '{' + payload.data.permissions.map(p => `"${p}"`).join(', ') + '}',
    inserted_at: new Date(),
    updated_at: new Date()
  }

  try {
    const existingRole = await db.roles.findOne({ name: payload.data.name, community_id: payload.data.community_id })
    if (existingRole != null) {
      roleData = Object.assign(roleData, { id: existingRole.id })
    }

    await db.roles.save(roleData)
  } catch (error) {
    logError('Something went wrong while updating role', error)
  }
}

async function assignRole (db, payload, blockInfo, _context) {
  console.log('Cambiatus >>> Assign Role', blockInfo.blockNumber)

  // `assignroles` is REPLACE-ALL: payload.data.roles is the member's COMPLETE desired
  // role-name list. After this updater the member's network_roles rows must EXACTLY equal
  // that list — insert the missing ones and DELETE the rows for roles no longer present.
  //
  // NOTE: `db` here is already the block-level serializable transaction opened by demux
  // (see GetActionsHandler.handleWithState). We write directly on it — mirroring netlink —
  // instead of opening a nested db.withTransaction, so every change is atomic with the
  // block and there is no separate connection that could commit before our writes land.

  // Make sure user belongs to the community
  const foundNetwork = await db.network.findOne({ community_id: payload.data.community_id, account_id: payload.data.member })
  if (foundNetwork == null) {
    // Skip instead of crashing the whole sync: a stale/missing reference must not
    // poison the process (it would otherwise exit and crash-loop under pm2).
    logError('assignRole: network not found, skipping action (DB behind chain)',
      new Error(`member=${payload.data.member} community=${payload.data.community_id} block=${blockInfo.blockNumber}`))
    return
  }

  // Resolve each desired role name to its roles.id for this community. Unknown role names
  // (DB roles table behind chain) are skipped and logged rather than throwing, so we keep
  // the rest of the list and avoid crash-looping the sync.
  const desiredRoleIds = []
  for (const roleName of payload.data.roles) {
    const foundRole = await db.roles.findOne({ community_id: payload.data.community_id, name: roleName })
    if (foundRole == null) {
      logError('assignRole: role not found, skipping this role (DB behind chain)',
        new Error(`role=${roleName} community=${payload.data.community_id} member=${payload.data.member} block=${blockInfo.blockNumber}`))
      continue
    }

    desiredRoleIds.push(foundRole.id)
  }

  // Current role ids the member has in Postgres
  const currentNetworkRoles = await db.network_roles.find({ network_id: foundNetwork.id })
  const currentRoleIds = currentNetworkRoles.map(networkRole => networkRole.role_id)

  // DELETE rows for roles the member no longer has (present in DB, absent from the action).
  // This is the bit that was missing: without it, removing a role on-chain never reflected
  // in Postgres.
  const roleIdsToRemove = currentRoleIds.filter(roleId => !desiredRoleIds.includes(roleId))
  for (const roleId of roleIdsToRemove) {
    await db.network_roles.destroy({ network_id: foundNetwork.id, role_id: roleId })
  }

  // INSERT rows for roles the member gained (present in the action, absent from DB).
  // Re-processing the same action inserts nothing here, so the updater is idempotent.
  const roleIdsToAdd = desiredRoleIds.filter(roleId => !currentRoleIds.includes(roleId))
  for (const roleId of roleIdsToAdd) {
    await db.network_roles.insert({
      network_id: foundNetwork.id,
      role_id: roleId,
      inserted_at: new Date(),
      updated_at: new Date()
    })
  }
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
