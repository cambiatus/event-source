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

## Deployment

Prod is a plain git checkout managed by **pm2** (not the stale `add_deploy_ansible` / systemd branch — ignore that).

- **Host:** `app.cambiatus.io` — `ssh ubuntu@app.cambiatus.io` (key is in the SSH agent). Same box also runs the EOS nodes (`producer`, `history-api` at `127.0.0.1:18888`) and the backend (`cambiatus-v2`).
- **Checkout:** `/home/ubuntu/apps/event-source`, tracking `origin/master`.
- **Process:** pm2 app named `event-source` (runs `src/app.js`). `NODE_ENV=prod` → loads `src/config/prod.js`; health server on port 3001. Node 16.

**Deploy = pull master + restart:**
```sh
ssh ubuntu@app.cambiatus.io
cd /home/ubuntu/apps/event-source
git status                       # check for uncommitted hotfixes FIRST (see caution)
git pull --ff-only origin master
yarn install                     # only if package.json changed; otherwise skip
pm2 restart event-source
```

**Verify after restart** (watch for a crash-loop):
```sh
pm2 status                                         # restart count should tick +1 only, status online, uptime growing
wc -l < ~/.pm2/logs/event-source-error.log         # expect 0
pm2 logs event-source --lines 30 --nostream        # clean boot: "Loaded Prod configs" → "Connected to postgres" → reader resumes from last block
```

**Cautions:**
- An uncaught throw in an updater → `unhandledRejection` → `logExit` → `process.exit(1)` → pm2 auto-restarts → **crash-loop** if the failure is deterministic. After deploy, confirm `restart_time` (`pm2 jlist`) is stable, not climbing.
- Prod's working tree has historically carried **uncommitted hand-patches** (e.g. an `assignRole` skip-and-log hotfix). Always `git status` before pulling; commit such changes upstream rather than discarding them. `git pull --ff-only` will refuse if the tree is dirty — `git stash` the change (recoverable) only after it is captured in git.
- The indexer resumes from `_index_state` in Postgres, so a restart picks up where it left off; no manual block seeking needed for a normal deploy.
