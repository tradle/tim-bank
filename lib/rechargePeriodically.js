
var typeforce = require('typeforce')
var request = require('request')
var debug = require('debug')('recharger')
var DEFAULT_CHUNK_SIZE = 50000
var DEFAULT_INTERVAL = 60000
var MAX_CHARGE = 150000

module.exports = function (opts) {
  typeforce({
    wallet: 'Object',
    minBalance: 'Number',
    chunkSize: '?Number',
    interval: '?Number'
  }, opts)

  var balance
  var canceled
  var minBalance = opts.minBalance
  var wallet = opts.wallet
  var address = wallet.addressString
  var chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE
  if (chunkSize > MAX_CHARGE) throw new Error('max is ' + MAX_CHARGE)

  var interval = opts.interval || DEFAULT_INTERVAL

  chargeIfLowBalance(reschedule)

  // return function that cancels periodic recharge
  return cancel

  function cancel () {
    canceled = true
  }

  function reschedule () {
    if (canceled) return

    setTimeout(function () {
      chargeIfLowBalance(reschedule)
    }, interval).unref()
  }

  function chargeIfLowBalance (cb) {
    updateBalance(function (err) {
      if (err) return cb(err)

      var charging = Math.max(minBalance - balance, 0)
      if (charging === 0) return cb()

      charging = Math.min(charging, MAX_CHARGE)
      var url = 'https://tradle.io/faucet/withdraw?'
      var charged = 0
      var numChunks = Math.ceil(charging / chunkSize)
      for (var i = 0; i < numChunks; i++) {
        if (i !== 0) url += '&'

        var amount = i === numChunks - 1
          ? charging - charged
          : chunkSize

        charged += amount
        url += 'address=' + address + '&amount=' + amount
      }

      debug('sending withdraw request to faucet for: ' + charging + ' satoshis to ' + address, url)
      // should be POST, but GET is supported for convenience
      request(url, function (err, resp, body) {
        if (err) return cb(err)
        if (resp.statusCode !== 200) {
          return cb(new Error(body || 'failed to withdraw'))
        }

        var txUrl = 'https://tbtc.blockr.io/tx/info/' + JSON.parse(body).data.txId
        debug('recharged', address, charged, 'satoshis, check tx:', txUrl)

        // update unconfirmed balance
        balance += charged
        debug('latest balance', address, balance, 'satoshis')
        cb()
      })
    })
  }

  function updateBalance (cb) {
    if (balance) return cb(null, balance)

    wallet.balance(function (err, satoshis) {
      balance = satoshis
      cb(err, satoshis)
    })
  }
}
