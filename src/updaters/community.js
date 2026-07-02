const { logError } = require('../logging')
const {
  getSymbolFromAsset,
  parseToken
} = require('../eos_helper')
const config = require(`../config/${process.env.NODE_ENV || 'dev'}`)
const { resolveClaimId, resolveCreatedActionId, resolveCreatedObjectiveId } = require('../chain')

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
      created_tx: payload.transactionId,
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
      created_tx: payload.transactionId,
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
    created_tx: payload.transactionId,
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

async function upsertObjective (db, payload, blockInfo, _context) {
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
    // Update path: an idempotent upsert by id (massive's save() emits an UPDATE
    // when the pk is present).
    data = Object.assign(data, { id: payload.data.objective_id })
    return db.objectives
      .save(data)
      .catch(e =>
        logError('Something went wrong while updating objective', e)
      )
  }

  // Idempotency (create path only): with no objective_id the payload carries no key, so
  // inserting without a guard would add a fresh row on every replay, duplicating the
  // objective. Keyed on created_tx — a create runs in exactly one on-chain tx, so a
  // matching row means we already indexed this create.
  const existing = await db.objectives.count({ created_tx: payload.transactionId })
  if (Number(existing) > 0) return

  // The DB objective.id MUST equal the chain objective id — the frontend signs
  // upsertobjctv(objective_id = db id) against the chain, so a drifted serial makes
  // the objective un-editable (and its actions un-creatable). The create payload
  // carries objective_id = 0 (the contract generates the id), so historically the DB
  // serial assigned it, which drifts from the chain counter after any duplicate/extra
  // insert. Recover the real id from chain: the smallest on-chain id this community
  // has that we don't have yet is this create (blocks are processed in order).
  //
  // On any failure (chain unreachable, no missing id) we fall back to the serial
  // rather than throw — a throw here becomes an unhandledRejection → process exit →
  // pm2 crash-loop. The serial was realigned to the chain counter by the 2026-07-02
  // remediation, so the fallback stays correct unless a new drift is introduced; the
  // explicit-id path is what keeps that drift from re-opening.
  try {
    const known = await db.objectives.find(
      { community_id: payload.data.community_id },
      { fields: ['id'] }
    )
    data.id = await resolveCreatedObjectiveId(
      config.blockchain.contract.community,
      payload.data.community_id,
      new Set(known.map(o => Number(o.id)))
    )
  } catch (e) {
    logError('Could not resolve chain objective id, falling back to serial', e)
    delete data.id
  }

  // insert(), not save(): with an id present save() emits an UPDATE (matching
  // nothing for a new id); without one the serial assigns it.
  return db.objectives
    .insert(data)
    .catch(e =>
      logError('Something went wrong while creating objective', e)
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

  return db.objectives.findOne({ id: payload.data.objective_id }).then(async o => {
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
    } else {
      // Idempotency (create path only): with no action_id the payload carries no key, so
      // inserting without a guard would add a fresh row on every replay, duplicating the
      // action (the audit found action ids 405+406 sharing one created_tx). Keyed on
      // created_tx — a create runs in exactly one on-chain tx, so a matching row means we
      // already indexed it. The update path (action_id > 0) is already an idempotent
      // upsert by id.
      const existing = await db.actions.count({ created_tx: payload.transactionId })
      if (Number(existing) > 0) return

      // The DB action.id MUST equal the chain action id — the frontend signs
      // upsertaction(action_id = db id) against the chain, and claimaction carries the
      // action_id too, so a drifted serial makes the action un-editable and its claims
      // point at the wrong row. The create payload carries action_id = 0 (the contract
      // generates the id), so historically the DB serial assigned it, which drifts from
      // the chain counter after any duplicate/extra insert. Recover the real id from
      // chain: the smallest on-chain id this objective has that we don't have yet is
      // this create (blocks are processed in order).
      //
      // Resolved HERE, before db.withTransaction below — a chain HTTP round-trip inside
      // the transaction would hold a DB connection open for its whole duration
      // (claimAction resolves before its insert for the same reason).
      //
      // On any failure (chain unreachable, no missing id) we fall back to the serial
      // rather than throw — a throw here becomes an unhandledRejection → process exit →
      // pm2 crash-loop. The serial was realigned to the chain counter by the 2026-07-02
      // remediation, so the fallback stays correct unless a new drift is introduced; the
      // explicit-id path is what keeps that drift from re-opening.
      try {
        const known = await db.actions.find(
          { objective_id: payload.data.objective_id },
          { fields: ['id'] }
        )
        data.id = await resolveCreatedActionId(
          config.blockchain.contract.community,
          payload.data.objective_id,
          new Set(known.map(a => Number(a.id)))
        )
      } catch (e) {
        logError('Could not resolve chain action id, falling back to serial', e)
        delete data.id
      }
    }

    return db.withTransaction(tx => {
      // Create path uses insert(), not save(): with an explicit id present save()
      // emits an UPDATE (matching nothing for a new id); insert() honors the id, and
      // without one the serial assigns it. The update path keeps save()'s upsert-by-id.
      const writeAction =
        payload.data.action_id > 0 ? tx.actions.save(data) : tx.actions.insert(data)

      return writeAction.then(savedAction => {
        // On update, replace the validator set: delete the old rows then
        // re-insert from validators_str. Both the delete and the inserts run
        // inside `tx` and are awaited, so the transaction commits only after
        // they complete. Previously the delete ran on `db` (a separate
        // connection) and neither it nor the inserts were awaited, so the tx
        // could commit before the inserts landed — or the out-of-tx delete
        // could race and wipe them — leaving an action with zero validators
        // and its claims permanently invisible to validators. Any failure now
        // rolls back the whole action instead of being silently swallowed.
        const replaceValidators =
          payload.data.action_id > 0
            ? tx.validators.destroy({ action_id: payload.data.action_id })
            : Promise.resolve()

        return replaceValidators.then(() =>
          Promise.all(
            validators.map(validator =>
              tx.validators.insert({
                action_id: savedAction.id,
                validator_id: validator,
                created_block: blockInfo.blockNumber,
                created_tx: payload.transactionId,
                created_eos_account: payload.authorization[0].actor,
                created_at: blockInfo.timestamp
              })
            )
          )
        )
      })
    }).catch(e =>
      logError(
        'Something went wrong while executing transaction to create an action',
        e
      )
    )
  })
}

async function reward (db, payload, blockInfo, context) {
  console.log(`Cambiatus >>> Action reward`, blockInfo.blockNumber)

  // Idempotency: a re-indexed block must not double-apply this reward. Without this guard a
  // replay both re-inserts the reward row AND decrements the action's usages_left a second
  // time (double corruption). Keyed on (action_id, receiver_id, awarder_id) — an automatic
  // action rewards a given receiver once per awarder, so this collapses true duplicates
  // without dropping real rewards. Mirrors the claimAction/transfer guards.
  const existing = await db.rewards.count({
    action_id: payload.data.action_id,
    receiver_id: payload.data.receiver,
    awarder_id: payload.data.awarder
  })
  if (Number(existing) > 0) return

  // Collect the action
  return db.actions
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

  // The DB claim.id MUST equal the chain claim id — the frontend signs
  // verifyclaim(claim.id) against the chain. The `claimaction` payload does not
  // carry the id (the contract generates it), so historically we let the DB serial
  // assign it, which drifts from the chain id after any duplicate/extra insert and
  // leaves claims unverifiable. Recover the real id from chain: the nth claim (by
  // ascending id) for this (action, claimer) is the nth we process for that pair.
  //
  // On any failure (chain unreachable, unexpected count) we fall back to the serial
  // rather than throw — a throw here becomes an unhandledRejection → process exit →
  // pm2 crash-loop. The serial is realigned to the chain by the one-time
  // claims-id-reconciliation, so the fallback stays correct unless a new drift is
  // introduced; the explicit-id path is what makes it robust against that.
  let claimId
  try {
    const ordinal = Number(await db.claims.count({
      action_id: payload.data.action_id,
      claimer_id: payload.data.maker
    }))
    claimId = await resolveClaimId(
      config.blockchain.contract.community,
      payload.data.action_id,
      payload.data.maker,
      ordinal
    )
  } catch (e) {
    logError('Could not resolve chain claim id, falling back to serial', e)
    claimId = undefined
  }

  const data = {
    ...(claimId ? { id: claimId } : {}),
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
    // Idempotency: the contract enforces exactly one vote per validator per claim, so a
    // replay must not insert a second check — doing so would inflate the vote counts below
    // and flip the claim to a wrong status. Keyed on (claim_id, validator_id): if this
    // validator already voted on this claim, skip the insert but still recompute the status.
    const alreadyVoted = Number(await tx.checks.count({
      claim_id: payload.data.claim_id,
      validator_id: payload.data.verifier
    }))
    if (alreadyVoted === 0) {
      await tx.checks.insert(checkData)
    }

    const claim = await tx.claims.findOne(payload.data.claim_id)
    console.log(`Cambiatus >>> Claim Verification: starting updating claims with id #${payload.data.claim_id}`)

    if (claim === null) {
      throw new Error('claim not available')
    }

    const action = await tx.actions.findOne(claim.action_id)
    if (action === null) {
      throw new Error('action not available')
    }

    // Recompute the status as a pure function of the CURRENT checks for this claim (not an
    // increment), matching the contract's verifyclaim math byte-for-byte. Because it derives
    // purely from the persisted checks it is self-healing: any future reprocess converges the
    // ~6,700 claims stuck `rejected` in Postgres back to their true on-chain status.
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

    // Decrement usages_left exactly once, on the first pending -> resolved transition. On a
    // replay the claim's stored status is already resolved, so this is skipped and we never
    // double-decrement. Preserves the contract's `!is_completed && usages > 0` conditions.
    if (claim.status === 'pending' && status !== 'pending' && !action.is_completed && action.usages > 0) {
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
    created_tx: payload.transactionId,
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
      created_tx: payload.transactionId,
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
