#!/usr/bin/env node

var path = require('path')
var Blockchain = require('@tradle/cb-blockr')
var Wallet = require('@tradle/simple-wallet')
var Table = require('cli-table')
var confPath = process.argv[2]
var conf = require(path.resolve(confPath))
if (!conf) throw new Error('specify conf file path')

var table = new Table({
  head: ['Bank', 'Address', 'Confirmed Balance', 'Unconfirmed Balance']
})

var togo = 0
Object.keys(conf.banks).forEach(function (name) {
  togo++
  var bank = conf.banks[name]
  var priv = require(path.resolve(bank.priv))
  var messagingKey = priv.filter(function (k) {
    return k.purpose === 'messaging'
  })[0]

  messagingKey.blockchain = new Blockchain('testnet')
  var wallet = new Wallet(messagingKey)
  var addr = wallet.addressString
  wallet.unspents(function (err, utxos) {
    if (err) {
      table.push([name, addr, 'FAILED: ' + err.message])
    } else {
      var uUnspents = 0
      var cUnspents = 0
      var ubalance = 0
      var cbalance = 0
      utxos.forEach(function (u) {
        if (u.confirmations) {
          cbalance += u.value
          cUnspents++
        } else {
          ubalance += u.value
          uUnspents++
        }
      })

      table.push([name, addr, cbalance + '(' + cUnspents + ')', ubalance + '(' + uUnspents + ')'])
    }

    finish()
  })

  // wallet.balance(function (err, balance) {
  //   if (err) {
  //     table.push([name, addr, 'FAILED: ' + err.message])
  //   } else {
  //     table.push([name, addr, balance])
  //   }

  //   finish()
  // })
})

function finish () {
  if (--togo === 0) {
    console.log(table.toString())
  }
}
