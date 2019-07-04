console.log('Loaded Prod configs')

const initialBlock = (typeof process.env.BLOCKCHAIN_INIT_BLOCK === 'string')
  ? parseInt(process.env.BLOCKCHAIN_INIT_BLOCK)
  : process.env.BLOCKCHAIN_INIT_BLOCK

module.exports = {
  blockchain: {
    contract: {
      token: process.env.BLOCKCHAIN_TOKEN_CONTRACT,
      community: process.env.BLOCKCHAIN_COMMUNITY_CONTRACT
    },
    url: process.env.BLOCKCHAIN_URL,
    initialBlock: initialBlock
  },
  db: {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    schema: 'public'
  },
  http: {
    port: process.env.EVENT_SOURCE_HTTP_PORT
  }
}
