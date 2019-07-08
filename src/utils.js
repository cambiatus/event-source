const Sentry = require('@sentry/node')
const crypto = require('crypto')

function logError (message) {
  return (error) => {
    console.log(message, error)
    Sentry.captureException(error)
  }
}

function toHash (message, algorithm, encoding) {
  return crypto
    .createHash(algorithm)
    .update(message)
    .digest(encoding)
}

function toSha256 (message) {
  return toHash(message, 'sha256', 'hex')
}

module.exports = {
  toHash,
  toSha256,
  logError
}
