// Local end-to-end config: syncs a local nodeos (contracts repo `make node-fresh`
// + `make bootstrap`) into the isolated `cambiatus_local` Postgres DB.
// Run with: NODE_ENV=local yarn start
console.log('Loaded Local configs')
module.exports = {
  blockchain: {
    contract: {
      token: 'cambiatus.tk',
      community: 'cambiatus.cm'
    },
    initialBlock: 1,
    url: 'http://127.0.0.1:8888'
  },
  db: {
    // No password key: node-pg must NOT send an empty-string password or Postgres.app
    // rejects it under trust auth ("failed to verify trust authentication").
    user: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'cambiatus_local',
    schema: 'public'
  },
  http: {
    port: 3001
  },
  sentry: {
    dsn: '',
    environment: 'local',
    attachStacktrace: true
  }
}
