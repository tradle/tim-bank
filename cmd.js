#!/usr/bin/env node

// var ppfile = require('ppfile')
require('multiplex-utp')

var path = require('path')
var fs = require('fs')
var dns = require('dns')
var Bank = require('./')
var DEFAULT_PORT = 51086
var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    i: 'identity',
    k: 'keys',
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

    new Bank({
      ip: addrs[0],
      port: argv.port || DEFAULT_PORT,
      networkName: 'testnet',
      identity: identity,
      identityKeys: keys,
      relay: {
        address: addrs[0],
        port: 25778
      }
    })
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
