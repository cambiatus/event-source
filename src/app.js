const config = require('./config')
const { BaseActionWatcher } = require("demux")
const { NodeosActionReader } = require("demux-eos")

const ObjectActionHandler = require("./ObjectActionHandler")
const updaters = require("./updaters")
const effects = require("./effects")


const actionReader = new NodeosActionReader(
  config.blockchain.url, config.blockchain.initialBlock
)

const actionHandler = new ObjectActionHandler(
  updaters,
  effects,
)

const actionWatcher = new BaseActionWatcher(
  actionReader,
  actionHandler,
  500,
)

actionWatcher.watch()
