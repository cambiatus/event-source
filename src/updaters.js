const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const {
  createCommunity,
  updateCommunity,
  netlink,
  transferSale,
  upsertObjective,
  upsertAction,
  reward,
  verifyClaim,
  claimAction,
  upsertRole,
  assignRole
} = require('./updaters/community.js')
const {
  createToken,
  updateToken,
  transfer,
  issue,
  retire,
  setExpiry,
  initacc
} = require('./updaters/token.js')

const updaters = [
  // ======== Community
  {
    actionType: `${config.blockchain.contract.community}::create`,
    updater: createCommunity
  },
  {
    actionType: `${config.blockchain.contract.community}::update`,
    updater: updateCommunity
  },
  {
    actionType: `${config.blockchain.contract.community}::netlink`,
    updater: netlink
  },
  {
    actionType: `${config.blockchain.contract.community}::upsertobjctv`,
    updater: upsertObjective
  },
  {
    actionType: `${config.blockchain.contract.community}::upsertaction`,
    updater: upsertAction
  },
  {
    actionType: `${config.blockchain.contract.community}::reward`,
    updater: reward
  },
  {
    actionType: `${config.blockchain.contract.community}::transfersale`,
    updater: transferSale
  },
  {
    actionType: `${config.blockchain.contract.community}::verifyclaim`,
    updater: verifyClaim
  },
  {
    actionType: `${config.blockchain.contract.community}::claimaction`,
    updater: claimAction
  },
  {
    actionType: `${config.blockchain.contract.community}::upsertrole`,
    updater: upsertRole
  },
  {
    actionType: `${config.blockchain.contract.community}::assignroles`,
    updater: assignRole
  },
  // ======== Token
  {
    actionType: `${config.blockchain.contract.token}::create`,
    updater: createToken
  },
  {
    actionType: `${config.blockchain.contract.token}::update`,
    updater: updateToken
  },
  {
    actionType: `${config.blockchain.contract.token}::transfer`,
    updater: transfer
  },
  {
    actionType: `${config.blockchain.contract.token}::issue`,
    updater: issue
  },
  {
    actionType: `${config.blockchain.contract.token}::retire`,
    updater: retire
  },
  {
    actionType: `${config.blockchain.contract.token}::setexpiry`,
    updater: setExpiry
  },
  {
    actionType: `${config.blockchain.contract.token}::initacc`,
    updater: initacc
  }
]

module.exports = updaters
