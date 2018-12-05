module.exports = {
  blockchain: {
    contract: 'bespiral',
    url: 'http://localhost:8888',
    // url: 'http://dev-chain.bespiral.io',
    // initialBlock: 3600
    initialBlock: 210000
  },
  db: {
    user: 'user',
    password: 'pass',
    host: 'localhost',
    port: 5432,
    database: 'eoslocal',
    schema: 'public'
  }
}
