const config = require('./config')
const { BaseActionWatcher } = require('demux')
const { NodeosActionReader } = require('demux-eos')
const { MassiveActionHandler } = require('demux-postgres')
const massive = require('massive')

const updaters = require('./updaters')
const effects = require('./effects')


async function init () {
  const actionReader = new NodeosActionReader(
    config.blockchain.url, config.blockchain.initialBlock
  )

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
    500,
  )

  actionWatcher.watch()
}

function exit (e)  {
  console.error("An error has occured. error is: %s and stack trace is: %s", e, e.stack)
  console.error("Process will restart now.")
  process.exit(1)
}

process.on("unhandledRejection", exit)
process.on("uncaughtException", exit)

setTimeout(init, 2500)
