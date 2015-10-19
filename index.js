var path = require('path')
var crypto = require('crypto')
var DHT = require('bittorrent-dht')
var leveldown = require('leveldown')
var utils = require('tradle-utils')
var rimraf = require('rimraf')
var fs = require('fs')
// var level = require('react-native-level')
var Driver = require('tim')
var Identity = require('midentity').Identity
// var tedPriv = require('chained-chat/test/fixtures/ted-priv')
// var Fakechain = require('blockloader/fakechain')
var Blockchain = require('cb-blockr')
// var Keeper = require('bitkeeper-js')
var Keeper = require('http-keeper')
var Wallet = require('simple-wallet')
// var fakeKeeper = help.fakeKeeper
// var fakeWallet = help.fakeWallet
// var ted = Identity.fromJSON(tedPriv)
var FIXTURES_DIR = './node_modules/tim/test/fixtures/'
var priv = require(FIXTURES_DIR + 'bill-priv.json')
var pub = require(FIXTURES_DIR + 'bill-pub.json')
var tim
var networkName = 'testnet'
var port = Number(process.argv[2]) || 51086

// var keeper = fakeKeeper.empty()

// var tedPub = new Buffer(stringify(require('./fixtures/ted-pub.json')), 'binary')
// var tedPriv = require('./fixtures/ted-priv')
// var ted = Identity.fromJSON(tedPriv)
// var tedPort = 51087
// var tedWallet = realWalletFor(ted)
// var blockchain = tedWallet.blockchain
// var tedWallet = walletFor(ted)

// clear(function () {
  // print(init)
// })

// clear(init)
init()

// ;['bill', 'ted'].forEach(function (prefix) {
//   var keeper = new Keeper({
//     storage: prefix + '-storage',
//     fallbacks: ['http://tradle.io:25667']
//   })

//   keeper.getAll()
//     .then(function (map) {
//       for (var key in map) {
//         keeper.push({
//           key: key,
//           value: map[key]
//         })
//       }
//     })
// })

// clear(function () {
//   var keeper = new Keeper({
//     storage: 'blah',
//     fallbacks: ['http://tradle.io:25667']
//   })

//   keeper.put(new Buffer('1'))
//     .then(function () {
//       return keeper.getAll()
//     })
//     .then(function (map) {
//       debugger
//       for (var key in map) {
//         keeper.push({
//           key: key,
//           value: map[key]
//         })
//       }
//     })
//     .catch(function (err) {
//       debugger
//     })
// })

function print (cb) {
  walk('./', function (err, results) {
    if (results && results.length) {
      results.forEach(function (r) {
        console.log(r)
      })
    }

    cb()
  })
}

function walk (dir, done) {
  var results = []
  fs.readdir(dir, function(err, list) {
    if (err) return done(err)
    var pending = list.length
    if (!pending) return done(null, results)
    list.forEach(function(file) {
      file = path.resolve(dir, file)
      fs.stat(file, function(err, stat) {
        if (stat && stat.isDirectory()) {
          walk(file, function(err, res) {
            results = results.concat(res)
            if (!--pending) done(null, results)
          })
        } else {
          results.push(file)
          if (!--pending) done(null, results)
        }
      })
    })
  })
}

function clear (cb) {
  var togo = 1
  rimraf('./', setTimeout.bind(null, finish, 100))

  ;[
    'addressBook.db',
    'msg-log.db',
    'messages.db',
    'txs.db'
  ].forEach(function (dbName) {
    ;[pub].forEach(function (identity) {
      togo++
      leveldown.destroy(getPrefix(identity) + '-' + dbName, finish)
    })
  })

  function finish () {
    if (--togo === 0) cb()
  }
}

function init () {
  setInterval(printIdentityStatus, 30000)
  tim = buildDriver(Identity.fromJSON(pub), priv, port)
  tim.once('ready', onTimReady)
  tim.on('error', function (err) {
    debugger
    console.error(err)
  })
}

function onTimReady () {
  console.log(tim.name(), 'is ready')

  printIdentityStatus()

  var identities = tim.identities()
  identities.onLive(function () {
    identities.createReadStream()
      .on('data', function (data) {
        console.log('identity', data)
      })
  })

  var messages = tim.messages()
  messages.onLive(function () {
    messages.createValueStream()
      .on('data', function (data) {
        tim.lookupObject(data)
          .then(function (obj) {
            console.log('msg', obj)
          })
      })
  })
}

function printIdentityStatus () {
  tim.identityPublishStatus(function (err, status) {
    console.log(tim.name(), 'identity publish status', status)
  })
}

function buildDriver (identity, keys, port) {
  var iJSON = identity.toJSON()
  var prefix = getPrefix(iJSON)
  var dht = dhtFor(iJSON)
  dht.listen(port)

  var keeper = new Keeper({
    storage: prefix + '-storage',
    fallbacks: ['http://tradle.io:25667']
  })

  var blockchain = new Blockchain(networkName)

  var d = new Driver({
    pathPrefix: prefix,
    networkName: networkName,
    keeper: keeper,
    blockchain: blockchain,
    leveldown: leveldown,
    identity: identity,
    identityKeys: keys,
    dht: dht,
    port: port,
    syncInterval: 60000
  })

  return d
}

function dhtFor (identity) {
  return new DHT({
    nodeId: nodeIdFor(identity),
    bootstrap: ['tradle.io:25778']
  })
}

function nodeIdFor (identity) {
  return crypto.createHash('sha256')
    .update(findKey(identity.pubkeys, { type: 'dsa' }).fingerprint)
    .digest()
    .slice(0, 20)
}

function findKey (keys, where) {
  var match
  keys.some(function (k) {
    for (var p in where) {
      if (k[p] !== where[p]) return false
    }

    match = k
    return true
  })

  return match
}

function getPrefix (identity) {
  return identity.name.firstName.toLowerCase()
}
