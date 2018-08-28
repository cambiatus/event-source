const amqpConf = {
  "address": "amqp://localhost",
  "channel": "demux"
}

module.exports = async () => {
  const amqp = require('amqplib/callback_api')

  const amqpSetup = new Promise((resolve, reject) => {
    amqp.connect(amqpConf.address, (err, conn) => {
      if (err) reject(err)
      conn.createChannel(function(err, ch) {
        if (err) reject(err)
        resolve(ch)
      })
    })
  })

  const amqpChannel = await amqpSetup

  const amqpSender = (payload) => {
    return amqpChannel.sendToQueue(
      amqpConf.channel,
      new Buffer(JSON.stringify(payload))
    )
  }

  return await amqpSender
}