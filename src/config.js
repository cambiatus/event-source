module.exports = {
  blockchain: {
    contract: 'bespiral',
    url: 'http://localhost:8888',
    // url: 'http://dev-chain.bespiral.io',
    initialBlock: 1
  },
  amqpConfig: {
    protocol: 'amqp',
    hostname: 'localhost',
    port: 5672,
    username: 'rabbitmq',
    passowrd: 'rabbitmq',
    vhost: '/'
  }
}
