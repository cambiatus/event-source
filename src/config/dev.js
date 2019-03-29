module.exports = {
  blockchain: {
    contract: 'bespiral',
    // url: 'http://localhost:8888',
    url: 'http://eosio.bespiral.local',
    // initialBlock: 1
    initialBlock: 3580
  },
  db: {
    user: 'lucca',
    password: '',
    host: 'localhost',
    port: 5432,
    database: 'bespiral_prod',
    schema: 'public'
  },
  http: {
    port: 3001
  }
}
