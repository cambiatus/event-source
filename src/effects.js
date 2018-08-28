function amqpBroadcast(state, payload, blockInfo, context) {
  console.info(`
\n=======\n
BeSpiral >>> New Action Broadcast ${JSON.stringify(payload, null, 2)}
\n=======\n
  `)
  state.amqp.sendToQueue(payload)
}

const effects = [
  {
    actionType: "bespiralcom1::createcmm",
    effect: amqpBroadcast,
  },
  {
    actionType: "bespiralcom1::netlink",
    effect: amqpBroadcast,
  },
  {
    actionType: "bespiralcom1::issue",
    effect: amqpBroadcast,
  },
  {
    actionType: "bespiralcom1::transfer",
    effect: amqpBroadcast,
  }
]

module.exports = effects