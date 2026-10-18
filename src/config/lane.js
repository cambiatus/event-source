// Claim-limits lane config: syncs a private lane nodeos (contracts repo `make lane-node-fresh`,
// port 8899) into an isolated `cambiatus_lane_cpa` Postgres DB. Never the shared chain or DB.
// Run with: NODE_ENV=lane node src/app.js
console.log('Loaded Lane configs')

const forbidden = ['cambiatus_local', 'cambiatus_dev', 'cambiatus_mirror', 'cambiatus_review']
const url = process.env.CHAIN_URL || 'http://127.0.0.1:8899'
if (url.includes(':8888') || forbidden.includes(process.env.PGDATABASE || '')) {
  throw new Error('lane config refuses the shared chain (:8888) and the shared DBs')
}

module.exports = {
  blockchain: {
    contract: {
      token: 'cambiatus.tk',
      community: 'cambiatus.cm',
      escrow: 'cambiatus.es'
    },
    initialBlock: 1,
    url
  },
  db: {
    // No password key: node-pg must NOT send an empty-string password or Postgres.app
    // rejects it under trust auth ("failed to verify trust authentication").
    user: 'postgres',
    host: 'localhost',
    port: 5432,
    database: process.env.PGDATABASE || 'cambiatus_lane_cpa',
    schema: 'public'
  },
  http: {
    port: Number(process.env.HEALTH_PORT || 3011)
  },
  sentry: {
    dsn: '',
    environment: 'lane',
    attachStacktrace: true
  }
}
