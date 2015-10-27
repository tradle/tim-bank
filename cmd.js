#!/usr/bin/env node

// var ppfile = require('ppfile')
require('multiplex-utp')

var express = require('express')
var path = require('path')
var fs = require('fs')
var dns = require('dns')
var Bank = require('./')
var buildNode = require('./lib/buildNode')
var Identity = require('tim').Identity
var createServer = require('tim-server')
var DEFAULT_TIM_PORT = 51086
var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    i: 'identity',
    k: 'keys',
    t: 'tim-port',
    p: 'port'
  }
})

if (!(argv.identity && argv.keys)) {
  throw new Error('specify input file')
}

// ppfile.decrypt(argv, function (err, contents) {
//   console.log(err || contents)
// })

var identity = JSON.parse(fs.readFileSync(path.resolve(argv.identity)))
// ppfile.decrypt({ in: argv.keys }, function () {
  var keys = JSON.parse(fs.readFileSync(path.resolve(argv.keys)))

  dns.resolve4('tradle.io', function (err, addrs) {
    if (err) throw err

    var tim = buildNode({
      ip: addrs[0],
      port: argv['tim-port'] || DEFAULT_TIM_PORT,
      networkName: 'testnet',
      identity: Identity.fromJSON(identity),
      identityKeys: keys,
      relay: {
        address: addrs[0],
        port: 25778
      }
    })

    var bank = new Bank({
      tim: tim
    })

    bank.wallet.balance(function (err, balance) {
      console.log('Balance: ', balance)
      console.log('Send coins to: ', bank.wallet.addressString)
    })

    if (!argv.port) return

    var app = express()
    if (argv.local) {
      app.use(function (req, res, next) {
        console.log(req)
        next()
      })
    }

    var server = app.listen(argv.port)

    createServer({
      tim: tim,
      app: app
    })

    console.log('Server running on port', argv.port)
  })
// })


// function print (cb) {
//   walk('./', function (err, results) {
//     if (results && results.length) {
//       results.forEach(function (r) {
//         console.log(r)
//       })
//     }

//     cb()
//   })
// }

// function walk (dir, done) {
//   var results = []
//   fs.readdir(dir, function(err, list) {
//     if (err) return done(err)
//     var pending = list.length
//     if (!pending) return done(null, results)
//     list.forEach(function(file) {
//       file = path.resolve(dir, file)
//       fs.stat(file, function(err, stat) {
//         if (stat && stat.isDirectory()) {
//           walk(file, function(err, res) {
//             results = results.concat(res)
//             if (!--pending) done(null, results)
//           })
//         } else {
//           results.push(file)
//           if (!--pending) done(null, results)
//         }
//       })
//     })
//   })
// }

// function clear (cb) {
//   var togo = 1
//   rimraf('./', setTimeout.bind(null, finish, 100))

//   ;[
//     'addressBook.db',
//     'msg-log.db',
//     'messages.db',
//     'txs.db'
//   ].forEach(function (dbName) {
//     ;[pub].forEach(function (identity) {
//       togo++
//       leveldown.destroy(getPrefix(identity) + '-' + dbName, finish)
//     })
//   })

//   function finish () {
//     if (--togo === 0) cb()
//   }
// }
