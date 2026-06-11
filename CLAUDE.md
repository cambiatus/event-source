# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
yarn          # install dependencies
yarn start    # lint then run (NODE_ENV=dev by default)
yarn format   # run StandardJS linter only
```

No test suite exists (`yarn test` exits 1).

Set `NODE_ENV=prod` to load `src/config/prod.js`.

## Architecture

Event broker: polls an EOS/EOSIO blockchain node and writes action data to PostgreSQL.

**Data flow:**
1. `NodeosActionReader` (demux-eos) reads blocks from the EOS node at `config.blockchain.url` starting from `config.blockchain.initialBlock`
2. `BaseActionWatcher` polls every 500ms
3. `MassiveActionHandler` (demux-postgres) matches each action's type string to an entry in the updaters array and calls the handler

**Key files:**
- `src/app.js` — wires up reader → handler → watcher; also starts a health-check HTTP server on `config.http.port`
- `src/updaters.js` — registry: maps `"contract::action"` strings to handler functions; `config.blockchain.contract.community` = `cambiatus.cm`, `.token` = `cambiatus.tk`
- `src/updaters/community.js` — all community contract handlers (create/update community, netlink, sales, objectives, actions, claims, roles)
- `src/updaters/token.js` — token contract handlers (create/update token, transfer, issue, retire, setExpiry)
- `src/eos_helper.js` — parses EOS asset strings (`"10.0000 SYM"`) into `[amount, symbol]`; symbol format is `"4,SYM"` (precision,ticker)
- `src/logging.js` — wraps Sentry; `logError(msg, err)` captures to Sentry, `logExit(err)` terminates process

**Updater function signature:**
```js
function myUpdater(db, payload, blockInfo, context) { ... }
```
- `db` — massive.js instance; tables accessed as `db.table_name.insert/update/findOne/find/count/save/destroy/withTransaction`
- `payload.data` — action fields from the smart contract
- `payload.transactionId`, `payload.authorization[0].actor` — tx metadata
- `blockInfo.blockNumber`, `blockInfo.timestamp` — block metadata

**Adding a new action handler:**
1. Write the function in the appropriate updater file
2. Export it
3. Add an entry to the `updaters` array in `src/updaters.js`

## Linter

StandardJS (no semicolons, 2-space indent). `yarn start` runs the linter before starting the process. A pre-commit hook (see README) enforces it on staged files.
