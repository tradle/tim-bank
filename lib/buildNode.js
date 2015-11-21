
var crypto = require('crypto')
var extend = require('xtend')
var typeforce = require('typeforce')
var leveldown = require('leveldown')
var Blockchain = require('@tradle/cb-blockr')
var DHT = require('@tradle/bittorrent-dht')
var Driver = require('tim')
var Keeper = require('@tradle/http-keeper')

module.exports = function buildNode (options) {
  typeforce({
    identity: 'Object',
    identityKeys: 'Array',
    port: 'Number',
    networkName: 'String'
  }, options)

  options = extend(options)
  var identityJSON = options.identity.toJSON()
  if (!options.pathPrefix) {
    options.pathPrefix = getPrefix(identityJSON)
  }

  if (options.dht === false) {
    options.dht = null
  } else if (!options.dht) {
    var dht = dhtFor(identityJSON)
    dht.listen(options.port)
    options.dht = dht
  }

  if (!options.keeper) {
    options.keeper = new Keeper({
      storeOnFetch: true,
      storage: options.pathPrefix + '-keeper',
      fallbacks: ['http://tradle.io:25667']
    })
  }

  if (!options.networkName) {
    options.networkName = 'testnet'
  }

  if (!options.blockchain) {
    options.blockchain = new Blockchain(options.networkName)
  }

  var d = new Driver(extend({
    leveldown: leveldown,
    syncInterval: 60000
  }, options))

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
