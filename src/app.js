const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const massive = require('massive')
const { BaseActionWatcher } = require('demux')
const { GetActionsReader } = require('./GetActionsReader')
const { GetActionsHandler } = require('./GetActionsHandler')
const { logInit, logExit } = require('./logging')

const updaters = require('./updaters')
const effects = []

const http = require('http')

async function init () {
  const contracts = [config.blockchain.contract.community, config.blockchain.contract.token]
  const actionReader = new GetActionsReader(
    config.blockchain.url,
    contracts,
    config.blockchain.initialBlock
  )
  console.info(
    `Querying EOS node on ${config.blockchain.url} via get_actions for ${contracts.join(', ')} from block#${config.blockchain.initialBlock}`
  )

  massive(config.db).then(db => {
    console.info('Connected to postgres')
    const actionHandler = new GetActionsHandler(
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
    res.writeHead(200, {
      'Content-Type': 'text/plain'
    })
    res.end('ok')
  })

  server.listen(config.http.port)
  console.info(`Endpoint health is running in ${config.http.port} port`)
}

process.on('unhandledRejection', logExit)
process.on('uncaughtException', logExit)

logInit()

init()
