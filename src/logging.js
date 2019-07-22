const Sentry = require('@sentry/node')
const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)

function logInit () {
  Sentry.init(config.sentry)
}

function logError (message) {
  return (error) => {
    console.log(message, error)
    Sentry.captureException(error)
  }
}

function logExit (error) {
  console.error('An error has occured. error is: %s and stack trace is: %s', error, error.stack)
  console.error('Process will exit now.')
  process.exit(1)
}

module.exports = {
  logInit,
  logError,
  logExit
}
