
// require('q-to-bluebird')
require('babel-polyfill')
require('@tradle/multiplex-utp')

var constants = require('@tradle/constants')
// for now
constants.TYPES.GET_MESSAGE = 'tradle.getMessage'
constants.TYPES.GET_HISTORY = 'tradle.getHistory'

// overwrite models for tests
var MODELS = require('@tradle/models')
var MODELS_BY_ID = {}
MODELS.forEach(function (m) {
  MODELS_BY_ID[m.id] = m
})

var CurrentAccount = MODELS_BY_ID['tradle.CurrentAccount']
var currentAccountForms = CurrentAccount.forms
CurrentAccount.forms = [
  'tradle.AboutYou',
  'tradle.YourMoney',
  'tradle.LicenseVerification'
]

var test = require('tape')
var express = require('express')
var Q = require('q')
var extend = require('xtend')
var find = require('array-find')
var memdown = require('memdown')
var DHT = require('@tradle/bittorrent-dht')
var Tim = require('tim')
Tim.CATCH_UP_INTERVAL = 2000
// Tim.Zlorp.ANNOUNCE_INTERVAL = Tim.Zlorp.LOOKUP_INTERVAL = 5000
Tim.CHAIN_WRITE_THROTTLE = 0
Tim.CHAIN_READ_THROTTLE = 0
Tim.SEND_THROTTLE = 0
var HttpClient = Tim.Messengers.HttpClient
var HttpServer = Tim.Messengers.HttpServer
var get = require('simple-get')
var Identity = require('@tradle/identity').Identity
var TYPE = constants.TYPE
var NONCE = constants.NONCE
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var origBuildNode = require('../lib/buildNode')
var utils = require('../lib/utils')
var Bank = require('../lib/simple')
var billPub = require('./fixtures/bill-pub')
var billPriv = require('./fixtures/bill-priv')
var tedPub = require('./fixtures/ted-pub')
var tedPriv = require('./fixtures/ted-priv')
var rufusPub = require('./fixtures/rufus-pub')
var rufusPriv = require('./fixtures/rufus-priv')
var types = constants.TYPES
var helpers = require('@tradle/test-helpers')
// var Keeper = require('offline-keeper')
var FakeKeeper = helpers.fakeKeeper
var createFakeWallet = helpers.fakeWallet
var NETWORK_NAME = 'testnet'
var BASE_PORT = 22222
var bootstrapDHT
var initCount = 0
var nonce = 0

var COMMON_OPTS = {
  leveldown: memdown,
  keeper: FakeKeeper.empty(),
  // keeper: new Keeper({
  //   storage: 'keeperStorage'
  // }),
  networkName: NETWORK_NAME,
  ip: '127.0.0.1',
  syncInterval: 3000
}

var APPLICANT
var BANK_SERVER
var BANK_REPS = [{
  pub: tedPub,
  priv: tedPriv
}, {
  pub: rufusPub,
  priv: rufusPriv
}]

var BANKS

;[init, initP2P].forEach(runTests)

function runTests (reinit, idx) {
  BANKS = []
  APPLICANT = null
  test('setup', function (t) {
    reinit()
      .then(function () {
        var everyone = getTims()
        return publishIdentities(everyone)
      })
      .finally(function () {
        t.end()
      })
  })

  test('current account', function (t) {
    var bank = BANKS[0]
    var bankCoords = getCoords(bank.tim)
    var verifications = {}
    var verificationsTogo = 3
    var verificationsDefer = Q.defer()

    // logging
    // getTims().forEach(function (tim) {
    //   var who = tim === APPLICANT ? 'applicant' : tim === BANKS[0].tim ? 'bank1' : 'bank2'
    //   tim.on('message', function (info) {
    //     tim.lookupObject(info)
    //       .then(function (obj) {
    //         console.log(who, 'received', JSON.stringify(obj.parsed.data, null, 2))
    //       })
    //   })
    // })

    APPLICANT.on('unchained', onUnchained)

    step1()
      .then(step2)
      .then(step3)
      .then(step4)
      .then(function () {
        bank = BANKS[1]
        bankCoords = getCoords(bank.tim)
        return verificationsDefer.promise
      })
      .then(bank2step1)
      .then(bank2step2)
      .then(bank2step3)
      .then(bank2step4)
      // .then(dumpDBs.bind(null, BANKS[0]))
      .done(function () {
        APPLICANT.removeListener('unchained', onUnchained)
        t.end()
      })

    function onUnchained (info) {
      if (info[TYPE] !== 'tradle.Verification') return

      APPLICANT.lookupObject(info)
        .then(function (obj) {
          var documentHash = obj.parsed.data.document.id.split('_')[1]
          return APPLICANT.lookupObjectByCurHash(documentHash)
        })
        .then(function (obj) {
          var vType = obj.parsed.data[TYPE]
          verifications[vType] = info[CUR_HASH]
          if (--verificationsTogo) return

          verificationsDefer.resolve()
        })
        .done()
    }

    function dumpDBs (bank) {
      var lists = CurrentAccount.forms.concat([
        'tradle.CurrentAccountConfirmation',
        'tradle.Verification'
      ])

      return Q.all(lists.map(function (name) {
          return bank.list(name)
        }))
        .then(function (results) {
          results.forEach(function (list, i) {
            list.forEach(function (item) {
              console.log(JSON.stringify(item.value, null, 2))
            })
          })
        })
    }

    function step1 () {
      var msg = utils.buildSimpleMsg(
        'application for',
        'tradle.CurrentAccount'
      )

      signNSend(msg)
      return awaitForm('tradle.AboutYou')
    }

    function step2 () {
      var msg = {
        nationality: 'British',
        residentialStatus: 'Living with parents',
        maritalStatus: 'Single'
      }

      msg[NONCE] = '' + (nonce++)
      msg[TYPE] = 'tradle.AboutYou'

      signNSend(msg)
      return Q.all([
        awaitForm('tradle.YourMoney'),
        awaitVerification()
      ])
    }

    function step3 () {
      var msg = {
        monthlyIncome: '5000 pounds',
        whenHired: 1414342441249
      }

      msg[NONCE] = '' + (nonce++)
      msg[TYPE] = 'tradle.YourMoney'

      signNSend(msg)
      return Q.all([
        awaitForm('tradle.LicenseVerification'),
        awaitVerification()
      ])
    }

    function step4 () {
      var msg = {
        licenseNumber: 'abc',
        dateOfIssue: 1414342441249
      }

      msg[NONCE] = '' + (nonce++)
      msg[TYPE] = 'tradle.LicenseVerification'

      signNSend(msg)
      return Q.all([
        awaitVerification(),
        awaitConfirmation()
      ])
    }

    function bank2step1 () {
      var msg = utils.buildSimpleMsg(
        'application for',
        'tradle.CurrentAccount'
      )

      signNSend(msg)
      return awaitForm('tradle.AboutYou')
    }

    function bank2step2 () {
      shareVerification('tradle.AboutYou')
      return awaitForm('tradle.YourMoney')
    }

    function bank2step3 () {
      shareVerification('tradle.YourMoney')
      return awaitForm('tradle.LicenseVerification')
    }

    function bank2step4 () {
      shareVerification('tradle.LicenseVerification')
      return awaitConfirmation()
    }

    function signNSend (msg) {
      APPLICANT.sign(msg)
        .then(function (signed) {
          return APPLICANT.send({
            msg: signed,
            to: bankCoords,
            deliver: true
          })
        })
        .done()
    }

    function shareVerification (type) {
      var opts = {
        chain: true,
        deliver: true,
        to: bankCoords
      }

      opts[CUR_HASH] = verifications[type]
      APPLICANT.share(opts)
    }

    function awaitVerification () {
      return awaitType('tradle.Verification')
    }

    function awaitConfirmation () {
      return awaitType('tradle.CurrentAccountConfirmation')
    }

    function awaitType (type) {
      var defer = Q.defer()
      APPLICANT.on('message', onmessage)
      return defer.promise
        .then(function () {
          APPLICANT.removeListener('message', onmessage)
        })

      function onmessage (info) {
        if (info[TYPE] === type) {
          defer.resolve()
        }
      }
    }

    function awaitForm (nextFormType) {
      var defer = Q.defer()
      APPLICANT.on('message', onmessage)
      return defer.promise
        .then(function () {
          APPLICANT.removeListener('message', onmessage)
        })

      function onmessage (info) {
        if (info[TYPE] !== types.SIMPLE_MESSAGE) {
          return
        }

        APPLICANT.lookupObject(info)
          .done(function (obj) {
            var text = obj.parsed.data.message
            t.equal(utils.parseSimpleMsg(text).type, nextFormType)
            defer.resolve()
          })
      }
    }
  })

  // test('wipe and recover', function (t) {
  //   var backup
  //   var bank = BANKS[0]
  //   var bankCoords = {}
  //   bankCoords[ROOT_HASH] = bank.tim.myRootHash()
  //   var options = APPLICANT.options()
  //   APPLICANT.history(bankCoords)
  //     .then(function (msgs) {
  //       backup = msgs
  //       return APPLICANT.destroy()
  //     })
  //     .then(function () {
  //       APPLICANT = new Tim(options)
  //       return APPLICANT.ready()
  //     })
  //     .then(function () {
  //       APPLICANT.on('message', oneDown)

  //       var msg = {}
  //       msg[TYPE] = constants.TYPES.GET_HISTORY
  //       msg[NONCE] = '' + nonce++
  //       return APPLICANT.send({
  //         msg: msg,
  //         to: [bankCoords],
  //         deliver: true
  //       })
  //     })
  //     .done()

  //   function oneDown (info) {
  //     var idx
  //     backup.some(function (msg, i) {
  //       if (msg[ROOT_HASH] === info[ROOT_HASH]) {
  //         idx = i
  //         t.pass('retrieved backed up msg')
  //         return true
  //       }
  //     })

  //     t.notEqual(idx, -1)
  //     backup.splice(idx, 1)
  //     if (!backup.length) {
  //       APPLICANT.removeListener('message', oneDown)
  //       t.end()
  //     }
  //   }
  // })

  test('teardown', function (t) {
    teardown()
      .done(function () {
        t.end()
      })
  })
}

function getTims () {
  return BANKS.map(function (b) {
    return b.tim
  }).concat(APPLICANT)
}

function buildNode (opts) {
  return origBuildNode(extend(COMMON_OPTS, {
    pathPrefix: opts.identity.name() + initCount
  }, opts))
}

function teardown () {
  if (BANK_SERVER) BANK_SERVER.close()
  return Q.all(BANKS.concat(APPLICANT).map(function (entity) {
      return entity.destroy()
    }))
    .then(function () {
      getTims().forEach(function (t) {
        if (t.dht) t.dht.destroy()
      })

      if (bootstrapDHT) bootstrapDHT.destroy()
    })
}

function initP2P () {
  var bootstrapDHTPort = BASE_PORT++
  bootstrapDHT = new DHT({ bootstrap: false })
  bootstrapDHT.listen(bootstrapDHTPort)
  var dhtConf = {
    bootstrap: ['127.0.0.1:' + bootstrapDHTPort]
  }

  var aPort = BASE_PORT++
  var aDHT = new DHT(dhtConf)
  aDHT.listen(aPort)

  var applicantWallet = walletFor(billPriv, null, 'messaging')
  APPLICANT = buildNode({
    dht: aDHT,
    wallet: applicantWallet,
    blockchain: applicantWallet.blockchain,
    identity: Identity.fromJSON(billPub),
    identityKeys: billPriv,
    port: aPort
  })

  BANKS = BANK_REPS.map(function (rep) {
    var port = BASE_PORT++
    var dht = new DHT(dhtConf)
    dht.listen(port)

    var tim = buildNode({
      dht: dht,
      blockchain: applicantWallet.blockchain,
      identity: Identity.fromJSON(rep.pub),
      identityKeys: rep.priv,
      port: port
    })

    var bank = new Bank({
      tim: tim,
      path: 'storage' + (initCount++),
      leveldown: memdown
    })

    return bank
  })

  return Q.all(getTims().map(function (t) {
    return t.ready()
  }))
}

function init () {
  // var bootstrapDHTPort = BASE_PORT++
  // bootstrapDHT = new DHT({ bootstrap: false })
  // bootstrapDHT.listen(bootstrapDHTPort)
  // var dhtConf = {
  //   bootstrap: ['127.0.0.1:' + bootstrapDHTPort]
  // }

  var aPort = BASE_PORT++
  // var aDHT = new DHT(dhtConf)
  // aDHT.listen(aPort)

  var applicantWallet = walletFor(billPriv, null, 'messaging')

  APPLICANT = buildNode({
    dht: false,
    wallet: applicantWallet,
    blockchain: applicantWallet.blockchain,
    messenger: new HttpClient(),
    identity: Identity.fromJSON(billPub),
    identityKeys: billPriv,
    port: aPort
  })

  APPLICANT.once('ready', function () {
    APPLICANT.messenger.setRootHash(APPLICANT.myRootHash())
  })

  var serverPort = BASE_PORT++
  var bankApp = express()
  BANK_SERVER = bankApp.listen(serverPort)

  BANKS = BANK_REPS.map(function (rep) {
    var port = BASE_PORT++
    // var dht = new DHT(dhtConf)
    // dht.listen(port)

    var router = express.Router()
    var httpServer = new HttpServer({
      router: router
    })

    var tim = buildNode({
      dht: false,
      blockchain: applicantWallet.blockchain,
      identity: Identity.fromJSON(rep.pub),
      identityKeys: rep.priv,
      port: port,
      messenger: httpServer
    })

    var bank = new Bank({
      tim: tim,
      manual: true,
      path: 'storage' + (initCount++),
      leveldown: memdown
    })

    httpServer.receive = bank.receiveMsg.bind(bank)

    tim.once('ready', function () {
      var rh = tim.myRootHash()
      bankApp.use('/' + rh, router)
      var url = 'http://127.0.0.1:' + serverPort + '/' + rh
      // var url = 'http://localhost:' + serverPort + '/' + rh
      APPLICANT.messenger.addRecipient(rh, url)
    })

    return bank
  })

  return Q.all(getTims().map(function (t) {
    return t.ready()
  }))
}

function publishIdentities (/* drivers */) {
  var defer = Q.defer()
  var drivers = Array.isArray(arguments[0])
    ? arguments[0]
    : [].concat.apply([], arguments)

  // Q.all(
  //   drivers.map(function (d) {
  //     return Q.nfcall(collect, d.identities())
  //   })
  // ).done(function (results) {
  //   var already = results.reduce(function (memo, next) {
  //     return memo + (next.reason ? 0 : next.value.length)
  //   })

    var togo = drivers.length * drivers.length
    drivers.forEach(function (d) {
      global.d = d
      d.on('unchained', onUnchained)
      d.publishMyIdentity()
        // .catch(function (err) {
        //   if (!/already/.test(err.message)) throw err
        // })
        // .done()
    })
  // })

  return defer.promise

  function onUnchained () {
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
