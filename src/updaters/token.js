const {
  logError
} = require('../logging')
const {
  parseToken
} = require('../eos_helper')

function createToken (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> Create Token`)

  const [, symbol] = parseToken(payload.data.max_supply)

  const updateData = {
    symbol: symbol,
    issuer: payload.data.issuer,
    max_supply: parseToken(payload.data.max_supply)[0],
    min_balance: parseToken(payload.data.min_balance)[0],
    type: payload.data.type
  }

  db.communities
    .update({ symbol: symbol }, updateData)
    .catch(e => logError('Something went wrong creating token', e))
}

function transfer (db, payload, blockInfo, context) {
  console.log(`BeSpiral >>> New Transfer`)

  const [ amount, symbol ] = parseToken(payload.data.quantity)

  const transferData = {
    from_id: payload.data.from,
    to_id: payload.data.to,
    amount: amount,
    community_id: symbol,
    memo: payload.data.memo,
    created_block: blockInfo.blockNumber,
    created_tx: payload.transactionId,
    created_eos_account: payload.authorization[0].actor,
    created_at: blockInfo.timestamp
  }

  db.transfers
    .insert(transferData)
    .catch(e => logError('Something went wrong while updating transfer data', e))
}

function issue (db, payload, blockInfo, context) {
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

  db.mints
    .insert(data)
    .catch(e => logError('Something went wrong while adding mint to community_mints table', e))
}

function retire (db, payload, blockInfo, context) {}

function setExpiry (db, payload, blockInfo, context) {}

module.exports = {
  createToken,
  transfer,
  issue,
  retire,
  setExpiry
}
