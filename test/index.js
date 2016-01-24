
// require('q-to-bluebird')
require('@tradle/multiplex-utp')

var crypto = require('crypto')
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
var IDENTITY_PUBLISHING_REQUEST = 'tradle.IdentityPublishRequest'
var LICENSE = 'tradle.LicenseVerification'
var ABOUT_YOU = 'tradle.AboutYou'
var YOUR_MONEY = 'tradle.YourMoney'
var VERIFICATION = constants.TYPES.VERIFICATION

CurrentAccount.forms = [
  ABOUT_YOU,
  YOUR_MONEY,
  LICENSE
]

var test = require('tape')
var typeforce = require('typeforce')
var express = require('express')
var Q = require('q')
var extend = require('xtend')
var find = require('array-find')
var memdown = require('memdown')
var DHT = require('@tradle/bittorrent-dht')
var DSA = require('@tradle/otr').DSA
var kiki = require('@tradle/kiki')
var Tim = require('tim')
var Zlorp = require('zlorp')
Tim.CATCH_UP_INTERVAL = 2000
// Tim.Zlorp.ANNOUNCE_INTERVAL = Tim.Zlorp.LOOKUP_INTERVAL = 5000
Tim.CHAIN_WRITE_THROTTLE = 0
Tim.CHAIN_READ_THROTTLE = 0
Tim.SEND_THROTTLE = 0
var Transport = extend(require('@tradle/transport-http'), {
  P2P: require('@tradle/transport-p2p'),
  WebSocketClient: require('@tradle/ws-client'),
  WebSocketRelay: require('@tradle/ws-relay')
})

var HttpClient = Transport.HttpClient
var HttpServer = Transport.HttpServer
var WebSocketClient = Transport.WebSocketClient
var WebSocketRelay = Transport.WebSocketRelay
var get = require('simple-get')
var Identity = require('@tradle/identity').Identity
var TYPE = constants.TYPE
var NONCE = constants.NONCE
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var origBuildNode = require('../lib/buildNode')
var utils = require('../lib/utils')
var Bank = require('../simple')
Bank.ALLOW_CHAINING = true
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
var pathCounter = 0
var initCount = 0
var nonce = 0

var sharedKeeper = FakeKeeper.empty()
var COMMON_OPTS = {
  leveldown: memdown,
  // TODO: test without shared keeper
  keeper: newKeeper(),
  // keeper: new Keeper({
  //   storage: 'keeperStorage'
  // }),
  networkName: NETWORK_NAME,
  ip: '127.0.0.1',
  syncInterval: 3000
}

var APPLICANT
var BANK_SERVER
var WEBSOCKET_RELAY
var BANK_REPS = [{
  pub: tedPub,
  priv: tedPriv
}, {
  pub: rufusPub,
  priv: rufusPriv
}]

var BANKS

;[
  {
    name: 'websockets',
    init: initWebsockets
  },
  {
    name: 'client/server',
    init: init
  },
  {
    name: 'p2p',
    init: initP2P
  }
].forEach(runTests)

function runTests (setup, idx) {
  BANKS = []
  APPLICANT = null
  test('setup ' + setup.name, function (t) {
    initCount++
    setup.init()
      .then(function () {
        // var everyone = getTims()
        var bankTims = BANKS.map(function (b) { return b.tim })
        return publishIdentities(bankTims)
      })
      .finally(function () {
        t.end()
      })
  })

  test('current account', function (t) {
    var bank = BANKS[0]
    var bankCoords = getCoords(bank.tim)
    var forms
    var verifications
    var verificationsTogo
    var verificationsDefer

    // logging
    // getTims().forEach(function (tim) {
    //   var who = tim === APPLICANT ? 'applicant' : tim === BANKS[0].tim ? 'bank2' : 'bank2'
    //   tim.on('message', function (info) {
    //     tim.lookupObject(info)
    //       .then(function (obj) {
    //         console.log(who, 'received', JSON.stringify(obj.parsed.data, null, 2))
    //       })
    //   })
    // })

    APPLICANT.on('unchained', onUnchained)

    cleanCache()
    sendIdentity()
      // bank shouldn't publish you twice
      .then(sendIdentityAgain)
      .then(runBank1Scenario)
      .then(function () {
        bank = BANKS[1]
        bankCoords = getCoords(bank.tim)
        return runBank2Scenario()
      })
      .then(function () {
        bank = BANKS[0]
        console.log('exercising right to be forgotten')
        return forget()
      })
      .then(function () {
        cleanCache()
        return runBank1Scenario()
      })
      // .then(dumpDBs.bind(null, BANKS[0]))
      .done(function () {
        APPLICANT.removeListener('unchained', onUnchained)
        t.end()
      })

    function runBank1Scenario () {
      return startApplication()
        .then(sendAboutYou)
        .then(sendYourMoney)
        .then(sendLicense)
        .then(function () {
          return verificationsDefer.promise
        })
    }

    function runBank2Scenario () {
      return bank2startApplication()
        .then(bank2sendAboutYouVer)
        .then(bank2sendYourMoneyVer)
        .then(bank2sendLicenseVer)
    }

    function cleanCache () {
      forms = {}
      verifications = {}
      verificationsTogo = 3
      verificationsDefer = Q.defer()
    }

    function onUnchained (info) {
      if (info[TYPE] !== VERIFICATION) return

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
        .catch(function (err) {
          if (err.name !== 'FileNotFoundError') throw err

          console.error('forgotten', info[TYPE], 'not found')
        })
        .done()
    }

    function dumpDBs (bank) {
      var lists = CurrentAccount.forms.concat([
        'tradle.CurrentAccountConfirmation',
        VERIFICATION
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

    function sendIdentity () {
      if (setup.init === initP2P) {
        // not implemented, publish manually
        return publishIdentities(APPLICANT)
      }

      var identityPubReq = {
        identity: APPLICANT.identityJSON
      }

      identityPubReq[NONCE] = '' + nonce++
      identityPubReq[TYPE] = constants.TYPES.IDENTITY_PUBLISHING_REQUEST
      signNSend(identityPubReq, { public: true })
      return Q.all([
          awaitTypeUnchained('tradle.Identity'),
          awaitType('tradle.IdentityPublished')
        ])
        .then(function () {
          t.pass('customer\'s identity was published')
        })
    }

    function sendIdentityAgain () {
      if (setup.init === initP2P) return

      var identityPubReq = {
        identity: APPLICANT.identityJSON
      }

      identityPubReq[NONCE] = '' + nonce++
      identityPubReq[TYPE] = constants.TYPES.IDENTITY_PUBLISHING_REQUEST
      signNSend(identityPubReq, { public: true })
      return awaitForm('tradle.Identity')
        .then(function () {
          t.pass('customer\'s identity was not published twice')
        })
    }

    function startApplication () {
      var msg = utils.buildSimpleMsg(
        'application for',
        'tradle.CurrentAccount'
      )

      signNSend(msg)
      return awaitForm(ABOUT_YOU)
        .then(function () {
          t.pass('got next form')
        })
    }

    function sendAboutYou () {
      var msg = {
        nationality: 'British',
        residentialStatus: 'Living with parents',
        maritalStatus: 'Single'
      }

      msg[NONCE] = crypto.randomBytes(32).toString('base64')// '' + (nonce++)
      msg[TYPE] = ABOUT_YOU

      signNSend(msg)
      return Q.all([
          awaitForm(YOUR_MONEY),
          awaitTypeUnchained(ABOUT_YOU),
          awaitVerification()
        ])
        .then(function () {
          t.pass('got next form')
        })
    }

    function sendYourMoney () {
      var msg = {
        monthlyIncome: '5000 pounds',
        whenHired: 1414342441249
      }

      msg[NONCE] = '' + (nonce++)
      msg[TYPE] = YOUR_MONEY

      signNSend(msg)
      return Q.all([
          awaitForm(LICENSE),
          awaitTypeUnchained(YOUR_MONEY),
          awaitVerification()
        ])
        .then(function () {
          t.pass('got next form')
        })
    }

    function sendLicense () {
      var msg = {
        licenseNumber: 'abc',
        dateOfIssue: 1414342441249
      }

      msg[NONCE] = '' + (nonce++)
      msg[TYPE] = LICENSE

      signNSend(msg)
      return Q.all([
        awaitTypeUnchained(LICENSE),
        awaitVerification(),
        awaitConfirmation()
      ])
    }

    function bank2startApplication () {
      var msg = utils.buildSimpleMsg(
        'application for',
        'tradle.CurrentAccount'
      )

      signNSend(msg)
      return awaitForm(ABOUT_YOU)
    }

    function bank2sendAboutYouVer () {
      shareVerification(ABOUT_YOU)
        .then(function () {
          shareForm(ABOUT_YOU)
        })

      return Q.all([
        awaitForm(YOUR_MONEY),
        awaitTypeUnchained(VERIFICATION)
      ])
    }

    function bank2sendYourMoneyVer () {
      shareVerification(YOUR_MONEY)
        .then(function () {
          shareForm(YOUR_MONEY)
        })

      return Q.all([
        awaitForm(LICENSE),
        awaitTypeUnchained(VERIFICATION)
      ])
    }

    function bank2sendLicenseVer () {
      shareVerification(LICENSE)
        .then(function () {
          shareForm(LICENSE)
        })

      return Q.all([
        awaitConfirmation(),
        awaitTypeUnchained(VERIFICATION)
      ])
    }

    function forget () {
      var msg = {
        reason: 'none of your business'
      }

      msg[NONCE] = '' + (nonce++)
      msg[TYPE] = 'tradle.ForgetMe'
      signNSend(msg)
      return awaitType('tradle.ForgotYou')
    }

    function signNSend (msg, opts) {
      APPLICANT.sign(msg)
        .then(function (signed) {
          // console.log(JSON.stringify(JSON.parse(signed), null, 2))
          return APPLICANT.send(extend({
            msg: signed,
            to: bankCoords,
            deliver: true
          }, opts || {}))
        })
        .done(function (entries) {
          var info = entries[0]
          forms[info.get(TYPE)] = info.get(ROOT_HASH)
        })
    }

    function shareForm (type) {
      var opts = {
        chain: false,
        deliver: true,
        to: bankCoords
      }

      opts[CUR_HASH] = forms[type]
      return APPLICANT.share(opts)
    }

    function shareVerification (type) {
      var opts = {
        chain: false,
        deliver: true,
        to: bankCoords
      }

      opts[CUR_HASH] = verifications[type]
      return APPLICANT.share(opts)
    }

    function awaitVerification () {
      return awaitType(VERIFICATION)
        .then(function () {
          t.pass('verified')
        })
    }

    function awaitConfirmation () {
      return awaitType('tradle.CurrentAccountConfirmation')
        .then(function () {
          t.pass('customer got account')
        })
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

    function awaitTypeUnchained (type) {
      var defer = Q.defer()
      APPLICANT.on('unchained', unchainedHandler)
      return defer.promise
        .then(function () {
          APPLICANT.removeListener('unchained', unchainedHandler)
        })

      function unchainedHandler (info) {
        if (info[TYPE] === type) {
          t.pass('unchained ' + type)
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
            t.equal(utils.parseSimpleMsg(text).type, nextFormType, 'got ' + nextFormType)
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
    pathPrefix: opts.identity.name() + initCount,
    syncInterval: 0,
    chainThrottle: 0,
    sendThrottle: 0
  }, opts))
}

function teardown () {
  if (WEBSOCKET_RELAY) WEBSOCKET_RELAY.destroy()
  if (BANK_SERVER) BANK_SERVER.close()
  return Q.all(BANKS.concat(APPLICANT).map(function (entity) {
      return entity.destroy()
    }))
    .then(function () {
      return Q.all(getTims().map(function (t) {
        return t.messenger && t.messenger.destroy()
      }))
    })
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
    keys: billPriv,
    port: aPort,
    messenger: newMessenger({
      keys: billPriv,
      identityJSON: billPub,
      port: aPort,
      dht: aDHT
    })
  })

  BANKS = BANK_REPS.map(function (rep, i) {
    var port = BASE_PORT++
    var dht = new DHT(dhtConf)
    dht.listen(port)

    var tim = buildNode({
      dht: dht,
      blockchain: applicantWallet.blockchain,
      identity: Identity.fromJSON(rep.pub),
      keys: rep.priv,
      port: port,
      messenger: newMessenger({
        keys: rep.priv,
        identityJSON: rep.pub,
        port: port,
        dht: dht
      })
    })

    var bank = new Bank({
      tim: tim,
      path: getNextBankPath(),
      leveldown: memdown
    })

    return bank
  })

  return Q.all(getTims().map(function (t) {
    return t.ready()
  }))
}

function getNextBankPath () {
  return 'storage' + pathCounter++
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
    keys: billPriv,
    port: aPort
  })

  APPLICANT.once('ready', function () {
    APPLICANT.messenger.setRootHash(APPLICANT.myRootHash())
  })

  var serverPort = BASE_PORT++
  var bankApp = express()
  BANK_SERVER = bankApp.listen(serverPort)

  BANKS = BANK_REPS.map(function (rep, i) {
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
      keys: rep.priv,
      port: port,
      messenger: httpServer
    })

    var bank = new Bank({
      tim: tim,
      manual: true,
      path: getNextBankPath(),
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

function initWebsockets () {
  var aPort = BASE_PORT++
  var applicantKeys = billPriv
  var applicantWallet = walletFor(applicantKeys, null, 'messaging')
  WEBSOCKET_RELAY = new WebSocketRelay({
    port: aPort
  })

  var relayURL = 'http://127.0.0.1:' + aPort
  var applicantClient = new WebSocketClient({
    url: relayURL,
    otrKey: getDSAKey(applicantKeys),
    // byRootHash: function (rootHash) {
    //   var coords = {}
    //   coords[ROOT_HASH] = rootHash
    //   return APPLICANT.lookupIdentity(coords)
    // }
  })

  APPLICANT = buildNode({
    dht: false,
    wallet: applicantWallet,
    blockchain: applicantWallet.blockchain,
    messenger: applicantClient,
    identity: Identity.fromJSON(billPub),
    keys: applicantKeys,
    port: aPort
  })

  APPLICANT.once('ready', function () {
    APPLICANT.messenger.setRootHash(APPLICANT.myRootHash())
  })

  BANKS = BANK_REPS.map(function (rep, i) {
    var port = BASE_PORT++
    // var dht = new DHT(dhtConf)
    // dht.listen(port)

    var router = express.Router()
    var httpServer = new HttpServer({
      router: router
    })

    var client = new WebSocketClient({
      url: relayURL,
      otrKey: getDSAKey(rep.priv),
      // byRootHash: function (rootHash) {
      //   var coords = {}
      //   coords[ROOT_HASH] = rootHash
      //   return tim.lookupIdentity(coords)
      // }
    })

    var tim = buildNode({
      dht: false,
      blockchain: applicantWallet.blockchain,
      identity: Identity.fromJSON(rep.pub),
      keys: rep.priv,
      port: port,
      messenger: client
    })

    tim.once('ready', function () {
      tim.messenger.setRootHash(tim.myRootHash())
    })

    var bank = new Bank({
      tim: tim,
      manual: true,
      path: getNextBankPath(),
      leveldown: memdown
    })

    client.on('message', function (buf, senderInfo) {
      bank.receiveMsg(buf, senderInfo)
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
        .done()
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

function getDSAKey (keys) {
  var key = keys.filter(function (k) {
    return k.type === 'dsa'
  })[0]

  return DSA.parsePrivate(key.priv)
}

/**
 * returns mock keeper with fallback to sharedKeeper (which hosts identities)
 */
function newKeeper () {
  var k = FakeKeeper.empty()
  var getOne = k.getOne
  k.getOne = function (key) {
    return getOne.apply(this, arguments)
      .catch(function (err) {
        return sharedKeeper.getOne(key)
      })
  }

  k.push = function (opts) {
    typeforce({
      key: 'String',
      value: 'Buffer'
    }, opts)

    return sharedKeeper.put(opts.key, opts.value)
  }

  return k
}

function newMessenger (opts) {
  typeforce({
    identityJSON: 'Object',
    keys: 'Array',
    port: 'Number',
    dht: 'Object'
  }, opts)

  return new Transport.P2P({
    zlorp: new Zlorp({
      available: true,
      leveldown: memdown,
      port: opts.port,
      dht: opts.dht,
      key: getDSAKey(opts.keys)
    })
  })
}
