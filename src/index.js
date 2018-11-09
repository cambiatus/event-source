const { BaseActionWatcher } = require("demux")
const { NodeosActionReader } = require("demux-eos")

const ObjectActionHandler = require("./ObjectActionHandler")
const updaters = require("./updaters")
const effects = require("./effects")

const actionReader = new NodeosActionReader(
  // "http://dev-chain.bespiral.io",
  "http://localhost:8888",
  1, // bespiral first cmm => 1768441
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
