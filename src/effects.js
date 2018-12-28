const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)

function logAction(state, payload, blockInfo, context) {
  console.info(`
\n=======\n
BeSpiral >>> New Action Broadcast ${JSON.stringify(payload, null, 2)}
\n=======\n
  `)
}

const effects = [
  {
    actionType: `${config.blockchain.contract}::createcmm`,
    effect: logAction
  },
  {
    actionType: `${config.blockchain.contract}::netlink`,
    effect: logAction
  },
  {
    actionType: `${config.blockchain.contract}::issue`,
    effect: logAction
  },
  {
    actionType: `${config.blockchain.contract}::transfer`,
    effect: logAction
  }
]

module.exports = effects
