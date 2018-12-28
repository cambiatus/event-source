module.exports = {
  blockchain: {
    contract: 'bespiral',
    url: 'http://eosio.bespiral.io',
    initialBlock: 0
  },
  db: {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_DATABASE,
    schema: 'public'
  }
}
