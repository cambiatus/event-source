const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const {
  createCommunity,
  updateCommunity,
  netlink,
  createSale,
  updateSale,
  deleteSale,
  voteSale,
  transferSale,
  newObjective,
  newAction,
  verifyAction
} = require('./updaters/community.js')
const {
  createToken,
  transfer,
  issue,
  retire,
  setExpiry
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
    actionType: `${config.blockchain.contract.community}::newobjective`,
    updater: newObjective
  },
  {
    actionType: `${config.blockchain.contract.community}::newaction`,
    updater: newAction
  },
  {
    actionType: `${config.blockchain.contract.community}::verifyaction`,
    updater: verifyAction
  },
  {
    actionType: `${config.blockchain.contract.community}::createsale`,
    updater: createSale
  },
  {
    actionType: `${config.blockchain.contract.community}::updatesale`,
    updater: updateSale
  },
  {
    actionType: `${config.blockchain.contract.community}::deletesale`,
    updater: deleteSale
  },
  {
    actionType: `${config.blockchain.contract.community}::votesale`,
    updater: voteSale
  },
  {
    actionType: `${config.blockchain.contract.community}::transfersale`,
    updater: transferSale
  },

  // ======== Token
  {
    actionType: `${config.blockchain.contract.token}::create`,
    updater: createToken
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
  }
]

module.exports = updaters
