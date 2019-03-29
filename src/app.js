const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const massive = require('massive')
const Sentry = require('@sentry/node');
const { BaseActionWatcher } = require('demux')
const { NodeosActionReader } = require('demux-eos')
const { MassiveActionHandler } = require('demux-postgres')

const updaters = require('./updaters')
const effects = []

const http = require('http')

async function init () {
  const actionReader = new NodeosActionReader(
    config.blockchain.url, config.blockchain.initialBlock
  )

  massive(config.db)
    .then(db => {
      console.info('Connected to postgres')
      const actionHandler = new MassiveActionHandler(
        updaters,
        effects,
        db,
        config.db.schema
      )

      const actionWatcher = new BaseActionWatcher(
        actionReader,
        actionHandler,
        500
      )
      actionWatcher.watch()
    })

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })

  server.listen(config.http.port)
  console.info(`Endpoint health is running in ${config.http.port} port`)
}

process.on("unhandledRejection", logExit)
process.on("uncaughtException", logExit)

function logExit (e) {
  console.error("An error has occured. error is: %s and stack trace is: %s", e, e.stack)
  console.error("Process will exit now.")
}

Sentry.init({
  dsn: 'https://37bc03165eee4885b75ef58190be1c05@sentry.io/1385219',
  environment: process.env.NODE_ENV || 'dev',
  attachStacktrace: true
})

init()
