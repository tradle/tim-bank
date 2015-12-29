#!/usr/bin/env node

var path = require('path')
var Blockchain = require('@tradle/cb-blockr')
var Wallet = require('@tradle/simple-wallet')
var Table = require('cli-table')
var confPath = process.argv[2]
var conf = require(path.resolve(confPath))
if (!conf) throw new Error('specify conf file path')

var table = new Table({
  head: ['Bank', 'Address', 'Balance']
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
  wallet.balance(function (err, balance) {
    if (err) {
      table.push([name, addr, 'FAILED: ' + err.message])
    } else {
      table.push([name, addr, balance])
    }

    finish()
  })
})

function finish () {
  if (--togo === 0) {
    console.log(table.toString())
  }
}
