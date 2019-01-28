module.exports = {
  blockchain: {
    contract: process.env.BLOCKCHAIN_CONTRACT,
    url: process.env.BLOCKCHAIN_URL,
    initialBlock: process.env.BLOCKCHAIN_INIT_BLOCK
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
