module.exports = {
  blockchain: {
    contract: 'bespiral',
    url: 'http://localhost:8888',
    // url: 'http://dev-chain.bespiral.io',
    initialBlock: 3600
  },
  db: {
    user: process.env.DB_USER || 'user',
    password: process.env.DB_PASSWORD || 'pass',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'eoslocal',
    schema: process.env.DB_SCHEMA || 'public'
  }
}
