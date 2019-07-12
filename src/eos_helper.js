const {
  Api,
  JsonRpc
} = require('eosjs')
const {
  JsSignatureProvider
} = require('eosjs/dist/eosjs-jssig')
const {
  TextDecoder,
  TextEncoder
} = require('util')
const fetch = require('node-fetch')
const config = require(`./config/${process.env.NODE_ENV || 'dev'}`)
const rpc = new JsonRpc(config.blockchain.url, { fetch })
const signatureProvider = new JsSignatureProvider([config.blockchain.privateKey])
const api = new Api({
  rpc: rpc,
  signatureProvider: signatureProvider,
  textDecoder: new TextDecoder(),
  textEncoder: new TextEncoder()
})

exports.parseToken = function (tokenString) {
  const [amountString, symbol] = tokenString.split(' ')
  const amount = parseFloat(amountString)
  return [amount, symbol]
}

exports.getLastSaleByHash = function (index) {
  return rpc.get_table_rows({
    json: true,
    code: config.blockchain.contract.community,
    scope: config.blockchain.contract.community,
    table: 'lastsale',
    table_key: 'byhash',
    key_type: 'sha256',
    upper_bound: index,
    index_position: 2,
    limit: 1
  })
}

exports.deleteLastSaleById = function (index) {
  const transaction = {
    actions: [{
      account: config.blockchain.contract.community,
      name: 'removels',
      authorization: [{
        actor: '',
        permission: 'active'
      }],
      data: {
        ls_id: index
      }
    }]
  }

  const tapos = {
    blocksBehind: 3,
    expireSeconds: 30
  }

  return api.transact(transaction, tapos)
}
