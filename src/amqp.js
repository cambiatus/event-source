const config = require('./config.js')

module.exports = async () => {
  const amqp = require('amqplib/callback_api')

  const amqpSetup = new Promise((resolve, reject) => {
    amqp.connect(config.amqpConfig, (err, conn) => {
      if (err) { reject(err); return }

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
