const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const { BaseActionWatcher } = require('demux')
const { NodeosActionReader } = require('demux-eos')
const { MassiveActionHandler } = require('demux-postgres')
const massive = require('massive')

const updaters = require('./updaters')
const effects = require('./effects')

const http = require('http')

async function init () {

  console.info(`BlockChain config:`)
  console.info(`\tURL ${config.blockchain.url}`)
  console.info(`\tCONTRACT ${config.blockchain.contract}`)
  console.info(`\tBLOCK INIT ${config.blockchain.initialBlock}`)

  const actionReader = new NodeosActionReader(
    config.blockchain.url, config.blockchain.initialBlock
  )

  console.info(`Database config:`)
  console.info(`\tUSER ${config.db.user}`)
  console.info(`\tPASS ${config.db.password}`)
  console.info(`\tHOST ${config.db.host}`)
  console.info(`\tPORT ${config.db.port}`)
  console.info(`\tDATABASE ${config.db.database}`)
  console.info(`\tSCHEMA ${config.db.schema}`)

  const db = await massive(config.db)

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

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })

  server.listen(config.http.port)

  console.info(`Endpoint health is running in ${config.http.port} port`)
}

function exit (e)  {
  console.error("An error has occured. error is: %s and stack trace is: %s", e, e.stack)
  console.error("Process will restart now.")
  process.exit(1)
}

process.on("unhandledRejection", exit)
process.on("uncaughtException", exit)

setTimeout(init, 2500)
