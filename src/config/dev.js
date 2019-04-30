console.log('Loaded Dev configs')
module.exports = {
  blockchain: {
    contract: {
      token: 'bes.token',
      community: 'bes.cmm'
    },
    url: 'http://eosio.bespiral.local',
    initialBlock: 1
    // initialBlock: 3580
  },
  db: {
    user: 'lucca',
    password: '',
    host: 'localhost',
    port: 5432,
    database: 'bespiral_dev',
    schema: 'public'
  },
  http: {
    port: 3001
  }
}
