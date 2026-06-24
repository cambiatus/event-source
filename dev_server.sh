#!/usr/bin/env bash
# Detached dev runner for event-source (chain → Postgres sync), mirroring
# backend/dev_server.sh so the two can be brought up the same way.
#
# Usage:
#   ./dev_server.sh start   — kill any running instance, start fresh
#   ./dev_server.sh stop    — kill running instance
#   ./dev_server.sh restart — stop + start
#   ./dev_server.sh logs    — tail the log
#   ./dev_server.sh status  — is it running?
#
# Needs: local nodeos at config.blockchain.url and the backend's Postgres
# (cambiatus_dev) already migrated. NODE_ENV defaults to dev.

cd "$(dirname "$0")" || exit 1

PID_FILE=".server.pid"
LOG_FILE=".server.log"
export NODE_ENV="${NODE_ENV:-dev}"
# Skip the StandardJS lint gate that `yarn start` runs first — this is a runtime
# launcher, not CI. Run node directly so a style nit can't block local startup.
CMD="node src/app.js"

stop() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null
      sleep 2
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
    fi
    rm -f "$PID_FILE"
    echo "stopped (was PID $PID)"
  else
    echo "not running"
  fi
}

start() {
  stop 2>/dev/null
  nohup $CMD > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "started (PID $(cat $PID_FILE)), NODE_ENV=$NODE_ENV, log: $LOG_FILE"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
    echo "running (PID $(cat $PID_FILE))"
  else
    echo "not running"
  fi
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  logs)    tail -f "$LOG_FILE" ;;
  status)  status ;;
  *)       echo "usage: $0 {start|stop|restart|logs|status}" ;;
esac
