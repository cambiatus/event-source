console.log('Loaded Dev configs')
module.exports = {
  blockchain: {
    contract: {
      token: 'bes.token',
      community: 'bes.cmm'
    },
    privateKey: '',
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
  },
  sentry: {
    dsn: 'https://4166852dea514426ace1f8911280f81d@sentry.io/1467639',
    environment: process.env.NODE_ENV || 'dev',
    attachStacktrace: true
  }
}
