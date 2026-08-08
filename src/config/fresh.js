// Scratch config for replay-bug reproduction: syncs the local nodeos from
// genesis into a FRESH, schema-only `cambiatus_fresh` Postgres DB.
// NOT committed — reproduction tooling only.
// Run with: NODE_ENV=fresh node src/app.js
console.log('Loaded Fresh configs')
module.exports = {
  blockchain: {
    contract: {
      token: 'cambiatus.tk',
      community: 'cambiatus.cm',
      escrow: 'cambiatus.es'
    },
    initialBlock: 1,
    url: 'http://127.0.0.1:8888'
  },
  db: {
    user: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'cambiatus_fresh',
    schema: 'public'
  },
  http: {
    port: 3002
  },
  sentry: {
    dsn: '',
    environment: 'fresh',
    attachStacktrace: true
  }
}
