'use strict'

var crypto = require('crypto')
var extend = require('xtend')
var typeforce = require('typeforce')
var leveldown = require('memdown')
var levelup = require('levelup')
// var Blockchain = require('@tradle/cb-blockr')
// var tradleUtils = require('@tradle/utils')
var constants = require('@tradle/engine').constants
var ROOT_HASH = constants.ROOT_HASH
var CUR_HASH = constants.CUR_HASH
var TYPE = constants.TYPE
var NONCE = constants.NONCE
var Driver = require('@tradle/engine').node
// var FakeKeeper = helpers.fakeKeeper
// var createFakeWallet = helpers.fakeWallet
var KEYS = [
  {
    type: 'bitcoin',
    purpose: 'payment'
  },
  {
    type: 'bitcoin',
    purpose: 'messaging'
  },
  {
    type: 'ec',
    purpose: 'sign'
  },
  {
    type: 'ec',
    purpose: 'update'
  },
  // {
  //   type: 'dsa',
  //   purpose: 'sign'
  // }
]

let dbCounter = 0
let INSTANCE_COUNT = 0

var utils = module.exports = {
  // genUser,
  walletFor,
  transactor,
  // newKeeper,
  getCoords,
  // getDSAKey,
  buildNode,
  findKey,
  getDataDir,
  nextDB,
  keeper
  // signAndSend
}

// function genUser (opts, cb) {
//   typeforce({
//     networkName: 'String',
//   }, opts)

//   var networkName = opts.networkName
//   var identity = new Identity()
//     .set(NONCE, tradleUtils.newMsgNonce())

//   var keys = KEYS.map(function (k) {
//     k = extend(k)
//     if (k.type === 'bitcoin') {
//       k.networkName = networkName
//     }

//     return kiki.toKey(k, true)
//   })

//   keys.forEach(identity.addKey, identity)

//   var info = {
//     profile: {
//       name: {
//         firstName: randomName.first(),
//         lastName: randomName.last()
//       }
//     },
//     pub: identity.toJSON(),
//     priv: keys.map(function (k) {
//       return k.exportPrivate()
//     })
//   }

//   var identityBuf = new Buffer(tradleUtils.stringify(info.pub))
//   tradleUtils.getStorageKeyFor(identityBuf, function (err, hash) {
//     if (err) return cb(err)

//     info[ROOT_HASH] = info[CUR_HASH] = hash.toString('hex')
//     cb(null, info)
//   })
// }

// function walletFor (opts) {
//   typeforce({
//     keys: 'Array',
//     blockchain: '?Object',
//     purpose: 'String',
//     networkName: 'String'
//   }, opts)

//   var unspents = []
//   for (var i = 0; i < 20; i++) {
//     unspents.push(100000)
//   }

//   return createFakeWallet({
//     blockchain: opts.blockchain,
//     unspents: unspents,
//     priv: opts.keys.find(function (k) {
//       return k.type === 'bitcoin' &&
//         k.networkName === opts.networkName &&
//         k.purpose === opts.purpose
//     }).priv
//   })
// }

function transactor (key, blockchain) {
  const wallet = helpers.wallet(key, blockchain)
  const transactor = Wallet.transactor({ wallet })
  transactor.blockchain = wallet.blockchain
  return transactor
}

function walletFor (key, blockchain) {
  var unspents = []
  for (var i = 0; i < 20; i++) {
    unspents.push(100000)
  }

  return fakeWallet({
    blockchain: blockchain,
    unspents: unspents,
    priv: key
  })
}

function getCoords (tim) {
  return {
    permalink: tim.permalink,
    link: tim.link
  }
}

// function getDSAKey (keys) {
//   var key = keys.filter(function (k) {
//     return k.type === 'dsa'
//   })[0]

//   return DSA.parsePrivate(key.priv)
// }

// /**
//  * returns mock keeper with fallback to sharedKeeper (which hosts identities)
//  */
// function newKeeper (sharedKeeper) {
//   var k = FakeKeeper.empty()
//   if (!sharedKeeper) return k

//   var getOne = k.getOne
//   k.getOne = function (key) {
//     return getOne.apply(this, arguments)
//       .catch(function (err) {
//         return sharedKeeper.getOne(key)
//       })
//   }

//   k.push = function (opts) {
//     typeforce({
//       key: 'String',
//       value: 'Buffer'
//     }, opts)

//     return sharedKeeper.put(opts.key, opts.value)
//   }

//   return k
// }

function buildNode (options) {
  typeforce({
    identity: 'Object',
    keys: 'Array',
    networkName: 'String',
    name: 'String',
    blockchain: 'Object'
  }, options)

  options = extend(options)
  if (!options.dir) {
    options.dir = options.name.replace(/[^a-zA-Z0-9]/g, '')
  }

  var db = options.leveldown || leveldown
  if (!options.keeper) {
    options.keeper = keeper()
  }

  if (!options.networkName) {
    options.networkName = 'testnet'
  }

  // if (!options.blockchain) {
  //   options.blockchain = new Blockchain(options.networkName)
  // }

  var d = new Driver(extend({
    leveldown: db,
    syncInterval: 60000
  }, options))

  d._send = options._send
  if (!d._send) {
    var m = options.messenger
    if (m) {
      d._send = m.send.bind(m)
      m.on('message', d.receive)
    }
  }

  return d
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

function getDataDir (identity) {
  return crypto.randomBytes(32).toString('hex')
  // return identity.name ? identity.name.firstName.toLowerCase() : identity.pubkeys[0].fingerprint
}

function nextDBName () {
  return 'db' + (dbCounter++)
}

function nextFeed () {
  return changesFeed(helpers.nextDB())
}

function nextDB (opts) {
  opts = opts || {}
  if (!opts.leveldown) opts.db = leveldown
  return utils.levelup(nextDBName(), opts)
}

function keeper () {
  return nextDB()
}
