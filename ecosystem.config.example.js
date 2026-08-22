// PM2 process definition for the production event-source indexer.
//
// Copy this to `ecosystem.config.js` ON THE SERVER and fill in the real values.
// The real file is intentionally NOT tracked: it holds the production database
// password in plaintext. It is also the only copy that exists, so if you change
// it, back it up off-box as well (see "Backups" below).
//
//   cp ecosystem.config.example.js ecosystem.config.js
//   $EDITOR ecosystem.config.js
//   pm2 restart event-source --update-env
//
// Every value below is read by src/config/prod.js straight off process.env, so
// the names here must match that file exactly.
//
// Backups: the live file lives at
//   /home/ubuntu/apps/event-source/ecosystem.config.js
// on app.cambiatus.io. Keep a copy somewhere private and chmod 600 — losing it
// means reconstructing the DB credentials by hand.

module.exports = {
  apps: [
    {
      name: 'event-source',
      time: true,
      script: 'src/app.js',
      watch: false,
      exec_mode: 'fork',
      autorestart: true,
      env: {
        NODE_ENV: 'prod',

        // Chain
        BLOCKCHAIN_INIT_BLOCK: '60000000',
        BLOCKCHAIN_TOKEN_CONTRACT: 'cambiatus.tk',
        BLOCKCHAIN_COMMUNITY_CONTRACT: 'cambiatus.cm',
        // Optional: src/config/prod.js defaults it to cambiatus.es when unset.
        BLOCKCHAIN_ESCROW_CONTRACT: 'cambiatus.es',
        BLOCKCHAIN_URL: 'https://<nodeos-host>',

        // Database — same Postgres the backend writes to.
        DB_USER: '<user>',
        DB_PASS: '<password>',
        DB_HOST: '<rds-endpoint>',
        DB_NAME: '<database>',

        EVENT_SOURCE_HTTP_PORT: 3001
      }
    }
  ]
}
