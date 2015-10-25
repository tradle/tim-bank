
require('multiplex-utp')

var test = require('tape')
var Q = require('q')
var extend = require('xtend')
var find = require('array-find')
var constants = require('tradle-constants')
var memdown = require('memdown')
var DHT = require('bittorrent-dht')
var Tim = require('tim')
Tim.CATCH_UP_INTERVAL = 1000
Tim.Zlorp.ANNOUNCE_INTERVAL = Tim.Zlorp.LOOKUP_INTERVAL = 5000
var Identity = require('midentity').Identity
var TYPE = constants.TYPE
var NONCE = constants.NONCE
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var origBuildNode = require('../lib/buildNode')
var Bank = require('../')
var billPub = require('./fixtures/bill-pub')
var billPriv = require('./fixtures/bill-priv')
var tedPub = require('./fixtures/ted-pub')
var tedPriv = require('./fixtures/ted-priv')
var types = require('../lib/types')
var helpers = require('tradle-test-helpers')
var FakeKeeper = helpers.fakeKeeper
var createFakeWallet = helpers.fakeWallet
var NETWORK_NAME = 'testnet'
var BASE_PORT = 22222
var bootstrapDHT

var COMMON_OPTS = {
  leveldown: memdown,
  keeper: FakeKeeper.empty(),
  networkName: NETWORK_NAME,
  ip: '127.0.0.1',
  syncInterval: 3000
}

var APPLICANT
var BANK

test('setup', function (t) {
  init()
    .then(function () {
      return publishIdentities(APPLICANT, BANK._tim)
    })
    .finally(function () {
      t.end()
    })
})

test('current account', function (t) {
  t.plan(5)

  var msg = {}
  msg[TYPE] = types.CurrentAccountApplication
  msg[NONCE] = '123'

  var signed
  APPLICANT.sign(msg)
    .then(function (_signed) {
      signed = _signed
      APPLICANT.send({
        msg: signed,
        to: getCoords(BANK._tim),
        deliver: true
      })
    })
    .done()

  var typesDetected = { unchained: {}, message: {} }
  ;['unchained', 'message'].forEach(function (event) {
    APPLICANT.on(event, function (info) {
      // confirmation of appliation
      var type = info[TYPE]
      if (typesDetected[event][type]) return

      typesDetected[event][type] = true
      switch (type) {
        case types.CurrentAccountApplication:
          return APPLICANT.lookupObject(info)
            .done(function (obj) {
              t.deepEqual(obj.data, signed)
            })
        case types.CurrentAccountConfirmation:
          return APPLICANT.lookupObject(info)
            .then(function (obj) {
              t.equal(obj[TYPE], types.CurrentAccountConfirmation)
              var applicationHash = obj.parsed.data.application
              var msgDB = APPLICANT.messages()
              return Q.ninvoke(msgDB, 'byCurHash', applicationHash)
            })
            .then(APPLICANT.lookupObject)
            .done(function (application) {
              t.deepEqual(application.data, signed)
            })
      }

    })
  })
})

test('teardown', function (t) {
  teardown()
    .done(function () {
      t.end()
    })
})

function buildNode (opts) {
  return origBuildNode(extend(COMMON_OPTS, opts))
}

function teardown () {
  return Q.all([
      APPLICANT.destroy(),
      BANK.destroy()
    ])
    .then(function () {
      APPLICANT.dht.destroy()
      BANK._tim.dht.destroy()
      bootstrapDHT.destroy()
    })
}

function init () {
  var bootstrapDHTPort = BASE_PORT++
  bootstrapDHT = new DHT({ bootstrap: false })
  bootstrapDHT.listen(bootstrapDHTPort)
  var dhtConf = {
    bootstrap: ['127.0.0.1:' + bootstrapDHTPort]
  }

  var aPort = BASE_PORT++
  var aDHT = new DHT(dhtConf)
  aDHT.listen(aPort)

  var bPort = BASE_PORT++
  var bDHT = new DHT(dhtConf)
  bDHT.listen(bPort)

  var applicantWallet = walletFor(billPriv, null, 'messaging')
  APPLICANT = buildNode({
    dht: aDHT,
    wallet: applicantWallet,
    blockchain: applicantWallet.blockchain,
    identity: Identity.fromJSON(billPub),
    identityKeys: billPriv,
    port: aPort
  })

  BANK = new Bank(extend(COMMON_OPTS, {
    dht: bDHT,
    blockchain: applicantWallet.blockchain,
    identity: Identity.fromJSON(tedPub),
    identityKeys: tedPriv,
    port: bPort
  }))

  var togo = 2
  var defer = Q.defer()
  ;[BANK._tim, APPLICANT].forEach(function (tim) {
    tim.once('ready', finish)
  })

  function finish () {
    if (--togo === 0) defer.resolve()
  }

  return defer.promise
}

function publishIdentities (/* drivers */) {
  var drivers = Array.isArray(arguments[0])
    ? arguments[0]
    : [].concat.apply([], arguments)

  var defer = Q.defer()
  var togo = drivers.length * drivers.length
  drivers.forEach(function (d) {
    global.d = d
    d.on('unchained', onUnchained)
    d.publishMyIdentity().done()
  })

  return defer.promise

  function onUnchained (info) {
    if (--togo) return

    drivers.forEach(function (d) {
      d.removeListener('unchained', onUnchained)
    })

    defer.resolve()
  }
}

function walletFor (keys, blockchain, purpose) {
  var unspents = []
  for (var i = 0; i < 20; i++) {
    unspents.push(100000)
  }

  return createFakeWallet({
    blockchain: blockchain,
    unspents: unspents,
    priv: find(keys, function (k) {
      return k.type === 'bitcoin' &&
        k.networkName === NETWORK_NAME &&
        k.purpose === purpose
    }).priv
  })
}

function getCoords (tim) {
  return [{
    fingerprint: tim.identityJSON.pubkeys[0].fingerprint
  }]
}
