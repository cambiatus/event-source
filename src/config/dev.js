console.log('Loaded Dev configs')
module.exports = {
  blockchain: {
    contract: {
      token: 'cambiatus.tk',
      community: 'cambiatus.cm'
    },
    initialBlock: 1,
    // initialBlock: 3580
    url: 'http://localhost:8888'
  },
  db: {
    user: 'postgres',
    password: '',
    host: 'localhost',
    port: 5432,
    database: 'cambiatus_dev',
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
