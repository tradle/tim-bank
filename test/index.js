'use strict'

// var LOG = require('why-is-node-running')
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
var MORTGAGE_LOAN_DETAIL = 'tradle.MortgageLoanDetail'
var ABOUT_YOU = 'tradle.AboutYou'
var YOUR_MONEY = 'tradle.YourMoney'
var VERIFICATION = constants.TYPES.VERIFICATION
var DEFAULT_AWAIT_OPTS = {
  awaitVerification: true,
  awaitConfirmation: true
}

var testProductList = [
  'tradle.CurrentAccount',
  'tradle.BusinessAccount',
  'tradle.Mortgage',
  'tradle.JumboMortgage',
  'tradle.MortgageProduct'
]

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
var clone = require('clone')
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
Tim.SEND_THROTTLE = 2000
var Transport = extend(require('@tradle/transport-http'), {
// var Transport = {
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
var testUtils = require('./utils')
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
var testHelpers = require('@tradle/test-helpers')
// var Keeper = require('offline-keeper')
var FakeKeeper = testHelpers.fakeKeeper
var createFakeWallet = testHelpers.fakeWallet
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
  // keeper: sharedKeeper,
  // keeper: new Keeper({
  //   storage: 'keeperStorage'
  // }),
  networkName: NETWORK_NAME,
  ip: '127.0.0.1',
  // syncInterval: 3000
}

var APPLICANT
var BANK_SERVER
var WEBSOCKET_RELAY
var BANK_BOTS = [{
  pub: tedPub,
  priv: tedPriv
}, {
  pub: rufusPub,
  priv: rufusPriv
}]

var BANKS

test('models', function (t) {
  const models = [
    {
      id: 'productA',
      subClassOf: 'tradle.FinancialProduct',
      forms: ['form1', 'form2']
    },
    {
      id: 'productB',
      subClassOf: 'tradle.FinancialProduct',
      forms: ['form1', 'form3']
    },
    {
      id: 'form1'
    },
    {
      id: 'form2'
    },
    {
      id: 'form3'
    }
  ]

  const modelsInfo = utils.processModels(models)
  t.deepEqual(modelsInfo.docs.productA, models[0].forms)
  t.deepEqual(modelsInfo.docs.productB, models[1].forms)
  t.ok(['form1', 'form2', 'form3'].every(f => modelsInfo.docs.indexOf(f) !== -1))
  t.ok(['productA', 'productB'].every(p => modelsInfo.products.indexOf(p) !== -1))
  models.forEach(m => {
    t.deepEqual(modelsInfo[m.id], m)
  })

  t.end()
})

testCustomProductConfirmation()
testGuestSession()
testRemediation()
testManualMode()

;[
  {
    name: 'websockets',
    init: initWebsockets
  },
  {
    name: 'client/server',
    init: initHTTP
  },
  {
    name: 'p2p',
    init: initP2P
  }
].forEach(runTests)

// testCustomProductList()

// function testCustomProductList () {
//   const models = MODELS.slice()

//   runSetup({
//     name: 'websockets',
//     init: initWebsockets.bind(null, {
//       models: models,
//       productList: ['tradle.CurrentAccount']
//     })
//   })

//   test('custom product list', function (t) {

//   })
// }

// function testSemiManualMode () {
//   BANKS = []
//   APPLICANT = null
//   var setup = {
//     name: 'websockets',
//     init: initWebsockets
//   }

//   runSetup(setup)

//   test('semi-manual mode', function (t) {
//     var bank = BANKS[0]
//     bank._auto.verify = false

//     var bankCoords = getCoords(bank.tim)
//     var product = 'tradle.CurrentAccount'
//     var approved = false
//     var confirmed = false
//     var helpers = getHelpers({
//       applicant: APPLICANT,
//       bank: bank,
//       forms: {},
//       verifications: {},
//       setup: setup,
//       t: t
//     })

//     helpers.sendIdentity(setup)
//       .then(() => helpers.startApplication(product))
//       .then(helpers.sendAboutYou)
//       .then(helpers.sendYourMoney)
//       .then(() => helpers.sendLicense({ awaitConfirmation: false }))
//       .then(() => {
//         return Q.Promise(resolve => setTimeout(resolve, 2000))
//       })
//       .then(() => {
//         debugger
//         t.equal(confirmed, false)
//         approved = true
//         return bank.approveProduct({
//           customerRootHash: APPLICANT.myRootHash(),
//           productType: product
//         })
//       })
//       .done()

//     helpers.awaitConfirmation()
//       .then(() => {
//         debugger
//         t.equal(approved, true)
//         confirmed = true
//         return teardown()
//       })
//       .done(function () {
//         t.end()
//       })
//   })
// }

// function testManualMode () {
//   BANKS = []
//   APPLICANT = null
//   var setup = {
//     name: 'websockets',
//     init: initWebsockets
//   }

//   runSetup(setup)

//   test('manual mode (confirmation triggers verifications)', function (t) {
//     var bank = BANKS[0]
//     bank._auto.approve = false
//     bank._auto.verify = false

//     var bankCoords = getCoords(bank.tim)
//     var product = 'tradle.CurrentAccount'
//     var approved = false
//     var confirmed = false
//     var helpers = getHelpers({
//       applicant: APPLICANT,
//       bank: bank,
//       forms: {},
//       verifications: {},
//       setup: setup,
//       t: t
//     })

//     helpers.sendIdentity(setup)
//       .then(() => helpers.startApplication(product))
//       .then(() => helpers.sendAboutYou({ awaitVerification: false }))
//       .then(() => helpers.sendYourMoney({ awaitVerification: false }))
//       .then(() => helpers.sendLicense({ awaitConfirmation: false }))
//       .then(() => {
//         return Q.Promise(resolve => setTimeout(resolve, 2000))
//       })
//       .then(() => {
//         t.equal(confirmed, false)
//         // should trigger verifications
//         return bank.approveProduct({
//           customerRootHash: APPLICANT.myRootHash(),
//           productType: product
//         })
//       })
//       .done(() => approved = true)

//     let verificationsTogo = 3
//     APPLICANT.on('message', info => {
//       if (info[TYPE] !== VERIFICATION) return

//       APPLICANT.lookupObject(info)
//         .then(obj => {
//           verificationsTogo--
//           t.pass('got verification for ' + obj.parsed.data.document.id)
//         })
//     })

//     helpers.awaitConfirmation()
//       .then(() => {
//         t.equal(approved, true)
//         t.equal(verificationsTogo, 0)
//         confirmed = true
//         return teardown()
//       })
//       .done(function () {
//         t.end()
//       })
//   })
// }

function testCustomProductConfirmation () {
  BANKS = []
  APPLICANT = null
  var setup = {
    name: 'client/server',
    init: initHTTP
  }

  runSetup(setup)

  test('custom product confirmation', function (t) {
    var bank = BANKS[0]
    var bankCoords = getCoords(bank.tim)
    var product = 'tradle.MortgageProduct'
    var productModel = MODELS[product]
    var productForms = productModel.forms
    var forms = {}
    var helpers = getHelpers({
      applicant: APPLICANT,
      bank: bank,
      forms: forms,
      verifications: {},
      setup: setup,
      t: t
    })

    helpers.sendIdentity(setup)
      // .then(() => helpers.startApplication(product))
      .then(() => {
        helpers.signNSend(utils.buildSimpleMsg(
          'application for',
          product
        ))

        return helpers.awaitForm(productForms[0])
      })
      .then(() => {
        return helpers.sendForms({
          forms: productForms,
          awaitVerification: false
        })
      })
      .done()

    Q.all([
        helpers.awaitVerification(3),
        helpers.awaitType('tradle.MyMortgage')
      ])
      .then(teardown)
      .done(function () {
        t.end()
      })
  })
}

function testGuestSession () {
  BANKS = []
  APPLICANT = null
  var setup = {
    name: 'websockets',
    init: initWebsockets
  }

  runSetup(setup)

  test('import guest session', function (t) {
    var bank = BANKS[0]
    var bankCoords = getCoords(bank.tim)
    var product = 'tradle.CurrentAccount'
    var forms = {}
    var helpers = getHelpers({
      applicant: APPLICANT,
      bank: bank,
      forms: forms,
      verifications: {},
      setup: setup,
      t: t
    })

    var sessionHash = 'blah'
    var incompleteAboutYou = newFakeData(ABOUT_YOU)
    var missing = 'photos'
    var missingVal = incompleteAboutYou[missing]
    delete incompleteAboutYou[missing]
    var yourMoney = newFakeData(YOUR_MONEY)
    var license = newFakeData(LICENSE)
    var session = [
      utils.buildSimpleMsg(
        'application for',
        product
      ),
      incompleteAboutYou,
      yourMoney,
      license,
      {
        [TYPE]: VERIFICATION,
        [NONCE]: '' + (nonce++),
        time: 10000,
        document: {
          [TYPE]: YOUR_MONEY
        }
      }
    ]

    bank.storeGuestSession(sessionHash, session)
      .then(() => helpers.sendIdentity(setup))
      .then(() => helpers.sendSessionIdentifier(sessionHash, 'tradle.FormError'))
      .then(info => APPLICANT.lookupObject(info))
      .then(obj => {
        const errors = obj.parsed.data.errors
        t.ok(errors.some(e => e.name === missing))
        incompleteAboutYou[missing] = missingVal
        helpers.signNSend(incompleteAboutYou)
        return helpers.awaitType('tradle.FormError')
      })
      .then(info => APPLICANT.lookupObject(info))
      .then(obj => {
        const message = obj.parsed.data.message
        t.ok(/review/.test(message))
        helpers.signNSend(yourMoney)
        return helpers.awaitType('tradle.FormError')
      })
      .then(info => APPLICANT.lookupObject(info))
      .then(obj => {
        const message = obj.parsed.data.message
        t.ok(/review/.test(message))
        helpers.signNSend(license)
        return helpers.awaitConfirmation()
      })
      .done()

    Q.all([
        helpers.awaitVerification(3),
        helpers.awaitConfirmation()
      ])
      .spread(verifications => {
        return Q.all(verifications.map(APPLICANT.lookupObject))
      })
      .then(verifications => {
        const yourMoneyV = find(verifications, v => {
          return v.parsed.data.document.id.split('_')[0] === YOUR_MONEY
        })

        t.equal(yourMoneyV.parsed.data.backDated, 10000)
        return teardown()
      })
      .done(function () {
        t.end()
      })
  })
}

function testRemediation () {
  BANKS = []
  APPLICANT = null
  var setup = {
    name: 'websockets',
    init: initWebsockets
  }

  runSetup(setup)

  test('import remediation', function (t) {
    var bank = BANKS[0]
    var bankCoords = getCoords(bank.tim)
    var product = 'tradle.Remediation'
    var forms = {}
    var helpers = getHelpers({
      applicant: APPLICANT,
      bank: bank,
      forms: forms,
      verifications: {},
      setup: setup,
      t: t
    })

    var sessionHash = 'blah'
    var aboutYou = newFakeData(ABOUT_YOU)
    var yourMoney = newFakeData(YOUR_MONEY)
    var license = newFakeData(LICENSE)
    var session = [
      utils.buildSimpleMsg(
        'application for',
        product
      ),
      aboutYou,
      yourMoney,
      license,
      {
        [TYPE]: VERIFICATION,
        [NONCE]: '' + (nonce++),
        time: 10000,
        document: {
          [TYPE]: YOUR_MONEY
        }
      }
    ]

    const verified = helpers.awaitVerification(3)
      .then(verifications => {
        return Q.all(verifications.map(APPLICANT.lookupObject))
      })
      .then(verifications => {
        const yourMoneyV = find(verifications, v => {
          return v.parsed.data.document.id.split('_')[0] === YOUR_MONEY
        })

        t.equal(yourMoneyV.parsed.data.backDated, 10000)
      })

    bank.storeGuestSession(sessionHash, session)
      .then(() => helpers.sendIdentity(setup))
      .then(() => helpers.sendSessionIdentifier(sessionHash, 'tradle.FormError'))
      .then(info => APPLICANT.lookupObject(info))
      .then(obj => {
        const message = obj.parsed.data.message
        t.ok(/review/.test(message))
        helpers.signNSend(aboutYou)
        return helpers.awaitType('tradle.FormError')
      })
      .then(info => APPLICANT.lookupObject(info))
      .then(obj => {
        const message = obj.parsed.data.message
        t.ok(/review/.test(message))
        helpers.signNSend(yourMoney)
        return helpers.awaitType('tradle.FormError')
      })
      .then(info => APPLICANT.lookupObject(info))
      .then(obj => {
        const message = obj.parsed.data.message
        t.ok(/review/.test(message))
        helpers.signNSend(license)
        return helpers.awaitType('tradle.SimpleMessage')
      })
      .then(info => APPLICANT.lookupObject(info))
      .then(msg => {
        t.ok(/confirm/.test(msg.parsed.data.message))
        return verified
      })
      .then(teardown)
      .done(function () {
        t.end()
      })

  })
}

function testManualMode () {
  BANKS = []
  APPLICANT = null
  var setup = {
    name: 'websockets',
    init: initWebsockets
  }

  runSetup(setup)

  test('manual verifications + confirmation', function (t) {
    var bank = BANKS[0]
    bank._auto.verify = false

    var bankCoords = getCoords(bank.tim)
    var product = 'tradle.CurrentAccount'
    var forms = {}
    var approved = false
    var helpers = getHelpers({
      applicant: APPLICANT,
      bank: bank,
      forms: forms,
      verifications: {},
      setup: setup,
      t: t
    })

    helpers.sendIdentity(setup)
      .then(() => helpers.startApplication(product))
      .then(() => helpers.sendAboutYou({ awaitVerification: false }))
      .then(() => {
        // should fail
        return bank.approveProduct({
          customerRootHash: APPLICANT.myRootHash(),
          productType: product
        })
      })
      .then(() => t.fail('approval should not be possible without requisite forms'))
      .catch(err => t.pass('approval prevented without required forms'))
      .then(() => helpers.sendYourMoney({ awaitVerification: false }))
      .then(() => helpers.sendLicense({ awaitVerification: false, awaitConfirmation: false }))
      // delay to make sure no auto-confirmation happens
      .then(() => Q.Promise(resolve => setTimeout(resolve, 2000)))
      .then(() => {
        // should fail
        return bank.approveProduct({
          customerRootHash: APPLICANT.myRootHash(),
          productType: product
        })
      })
      .then(() => t.fail('approval should not be possible without verifications'))
      .catch(err => t.pass('verifications enforced as pre-req to approval'))
      .then(() => {
        return Q.all(Object.keys(forms).map(type => {
          return bank.sendVerification({
            verifiedItem: forms[type]
          })
        }))
      })
      .then(() => {
        // should succeed
        return bank.approveProduct({
          customerRootHash: APPLICANT.myRootHash(),
          productType: product
        })
      })
      .done(() => approved = true)

    let verificationsTogo = 3
    APPLICANT.on('message', info => {
      if (info[TYPE] !== VERIFICATION) return

      APPLICANT.lookupObject(info)
        .then(obj => {
          t.equal(--verificationsTogo >= 0, true)
          t.pass('got verification for ' + obj.parsed.data.document.id.split('_')[0])
        })
    })

    helpers.awaitConfirmation()
      .then(() => {
        t.equal(approved, true)
        t.equal(verificationsTogo, 0)
        return teardown()
      })
      .done(function () {
        t.end()
      })
  })
}

function runTests (setup, idx) {
  BANKS = []
  APPLICANT = null
  runSetup(setup)

  test('current account', function (t) {
    var bank
    var bankCoords
    var forms
    var verifications
    var verificationsTogo
    var verificationsDefer
    var helpers

    cleanCache()
    changeBank(BANKS[0])

    APPLICANT.on('unchained', onUnchained)


    // tryUnacquainted() // TODO: get this working
    Q()
      .then(() => helpers.sendIdentity(setup))
      // bank shouldn't publish you twice
      .then(() => helpers.sendIdentityAgain(setup))
      .then(runBank1Scenario)
      .then(function () {
        changeBank(BANKS[1])
        return runBank2Scenario()
      })
      .then(function () {
        bank = BANKS[0]
        console.log('exercising right to be forgotten')
        return helpers.forget()
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

    function changeBank (newBank) {
      bank = newBank
      bankCoords = getCoords(bank.tim)
      helpers = getHelpers({
        applicant: APPLICANT,
        bank: bank,
        forms: forms,
        verifications: verifications,
        setup: setup,
        t: t
      })
    }

    function runBank1Scenario () {
      return helpers.startApplication()
        .then(helpers.sendAboutYou)
        .then(helpers.sendYourMoney)
        .then(helpers.sendIncompleteLicense)
        .then(helpers.sendLicense)
        .then(function () {
          return verificationsDefer.promise
        })
    }

    function runBank2Scenario () {
      return helpers.startApplication()
        .then(helpers.shareAboutYouVer)
        .then(helpers.shareYourMoneyVer)
        .then(helpers.shareLicenseVer)
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

    // function dumpDBs (bank) {
    //   var lists = CurrentAccount.forms.concat([
    //     'tradle.CurrentAccountConfirmation',
    //     VERIFICATION
    //   ])

    //   return Q.all(lists.map(function (name) {
    //       return bank.list(name)
    //     }))
    //     .then(function (results) {
    //       results.forEach(function (list, i) {
    //         list.forEach(function (item) {
    //           console.log(JSON.stringify(item.value, null, 2))
    //         })
    //       })
    //     })
    // }
  })

  test('teardown', function (t) {
    teardown()
      .done(function () {
        t.end()
      })
  })
}

function getHelpers (opts) {
  typeforce({
    applicant: 'Object',
    bank: 'Object',
    forms: 'Object',
    verifications: 'Object',
    setup: 'Object',
    t: 'Object'
  }, opts)

  const applicant = opts.applicant
  const bank = opts.bank
  const forms = opts.forms
  const verifications = opts.verifications
  const setup = opts.setup
  const t = opts.t
  const bankCoords = getCoords(bank.tim)
  return {
    sendIdentity,
    sendIdentityAgain,
    sendSessionIdentifier,
    startApplication,
    tryUnacquainted,
    sendForm,
    sendForms,
    sendAboutYou,
    sendYourMoney,
    sendLicense,
    sendIncompleteLicense,
    shareAboutYouVer,
    shareYourMoneyVer,
    shareLicenseVer,
    forget,
    signNSend,
    shareForm,
    shareVerification,
    awaitForm,
    awaitVerification,
    awaitType,
    awaitConfirmation,
    awaitTypeUnchained
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
        awaitTypeUnchained('tradle.Identity', APPLICANT),
        awaitTypeUnchained('tradle.Identity', BANKS[0].tim),
        awaitTypeUnchained('tradle.Identity', BANKS[1].tim),
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

  function sendSessionIdentifier (identifier, waitType) {
    var msg = {
      [TYPE]: 'tradle.GuestSessionProof',
      session: identifier
    }

    signNSend(msg)
    return waitType && awaitType(waitType)
  }

  function startApplication (productType) {
    productType = productType || 'tradle.CurrentAccount'
    var model = MODELS_BY_ID[productType]
    var msg = utils.buildSimpleMsg(
      'application for',
      productType
    )

    signNSend(msg)
    return awaitForm(model.forms[0])
      .then(function () {
        t.pass('got next form')
      })
  }

  function tryUnacquainted () {
    var msg = {
      [TYPE]: 'tradle.SimpleMessage',
      [NONCE]: '' + nonce++,
      hey: 'ho'
    }

    signNSend(msg)
    return Q.all([
        awaitType('tradle.NotFound')
      ])
      .then(function () {
        t.pass('unacquainted gets NotFound')
      })
  }

  function sendAboutYou (opts) {
    opts = opts || DEFAULT_AWAIT_OPTS
    signNSend(newFakeData(ABOUT_YOU))
    return Q.all([
        awaitForm(YOUR_MONEY),
        awaitTypeUnchained(ABOUT_YOU),
        opts.awaitVerification && awaitVerification()
      ])
      .then(function () {
        t.pass('got next form')
      })
  }

  function sendYourMoney (opts) {
    opts = opts || DEFAULT_AWAIT_OPTS
    signNSend(newFakeData(YOUR_MONEY))
    return Q.all([
        awaitForm(LICENSE),
        awaitTypeUnchained(YOUR_MONEY),
        opts.awaitVerification && awaitVerification()
      ])
      .then(function () {
        t.pass('got next form')
      })
  }

  function sendLicense (opts) {
    opts = opts || DEFAULT_AWAIT_OPTS
    signNSend(newFakeData(LICENSE))
    return Q.all([
      awaitTypeUnchained(LICENSE),
      opts.awaitVerification && awaitVerification(),
      opts.awaitConfirmation && awaitConfirmation()
    ])
  }

  // function sendMortgageLoanDetail (opts) {
  //   opts = opts || DEFAULT_AWAIT_OPTS
  //   return sendForm(extend({
  //     form: MORTGAGE_LOAN_DETAIL
  //   }, DEFAULT_AWAIT_OPTS))
  // }

  function sendForm (opts) {
    typeforce({
      form: 'String'
    }, opts)

    const form = opts.form
    signNSend(newFakeData(form))
    return Q.all([
        opts.nextForm && awaitForm(opts.nextForm),
        awaitTypeUnchained(form),
        opts.awaitVerification && awaitVerification(),
        opts.awaitConfirmation && awaitConfirmation()
      ])
      .then(function () {
        if (opts.nextForm) t.pass('got next form')
      })
  }

  function sendForms (opts) {
    typeforce({
      forms: 'Array'
    }, opts)

    const forms = opts.forms
    return forms.reduce(function (promise, f, idx) {
      return promise.then(function () {
        return sendForm(extend({
          form: f,
          nextForm: forms[idx + 1]
        }, opts))
      })
    }, Q())
  }

  function sendIncompleteLicense (opts) {
    opts = opts || DEFAULT_AWAIT_OPTS
    var msg = {
      licenseNumber: 'abc',
      dateOfIssue: 1414342441249
    }

    msg[NONCE] = '' + (nonce++)
    msg[TYPE] = LICENSE

    signNSend(msg)
    return awaitType('tradle.FormError')
  }

  function shareAboutYouVer () {
    shareVerification(ABOUT_YOU)
      .then(function () {
        shareForm(ABOUT_YOU)
      })

    return Q.all([
      awaitForm(YOUR_MONEY),
      awaitTypeUnchained(VERIFICATION)
    ])
  }

  function shareYourMoneyVer () {
    shareVerification(YOUR_MONEY)
      .then(function () {
        shareForm(YOUR_MONEY)
      })

    return Q.all([
      awaitForm(LICENSE),
      awaitTypeUnchained(VERIFICATION)
    ])
  }

  function shareLicenseVer () {
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
    applicant.sign(msg)
      .then(function (signed) {
        // console.log(JSON.stringify(JSON.parse(signed), null, 2))
        return applicant.send(extend({
          msg: signed,
          to: bankCoords,
          deliver: true
        }, opts || {}))
      })
      .done(function (entries) {
        var info = entries[0]
        var type = info.get(TYPE)
        if (MODELS_BY_ID[type].subClassOf === 'tradle.Form' || CurrentAccount.forms.indexOf(type) !== -1) {
          forms[info.get(TYPE)] = info.get(ROOT_HASH)
        }
      })
  }

  function shareForm (type) {
    var opts = {
      chain: false,
      deliver: true,
      to: bankCoords
    }

    opts[CUR_HASH] = forms[type]
    return applicant.share(opts)
  }

  function shareVerification (type) {
    var opts = {
      chain: false,
      deliver: true,
      to: bankCoords
    }

    opts[CUR_HASH] = verifications[type]
    return applicant.share(opts)
  }

  function awaitVerification (n) {
    n = n || 1
    return awaitType(VERIFICATION, n)
      .then(function (verifications) {
        t.pass(`received ${n} tradle.Verification`)
        return verifications
      })
  }

  function awaitConfirmation () {
    return awaitType('tradle.CurrentAccountConfirmation')
      .then(function () {
        t.pass('customer got account')
      })
  }

  function awaitType (type, n) {
    n = n || 1
    let togo = n
    const defer = Q.defer()
    const received = []
    applicant.on('message', onmessage)
    return defer.promise
      .then(function (ret) {
        applicant.removeListener('message', onmessage)
        return ret
      })

    function onmessage (info) {
      if (info[TYPE] === type) {
        t.pass('received ' + type)
        received.push(info)
        if (--togo === 0) defer.resolve(n === 1 ? received[0] : received)
      }
    }
  }

  function awaitTypeUnchained (type, tim) {
    var defer = Q.defer()
    tim = tim || applicant
    tim.on('unchained', unchainedHandler)
    return defer.promise
      .then(function () {
        tim.removeListener('unchained', unchainedHandler)
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
    applicant.on('message', onmessage)
    return defer.promise
      .then(function () {
        applicant.removeListener('message', onmessage)
      })

    function onmessage (info) {
      if (info[TYPE] !== types.SIMPLE_MESSAGE) {
        return
      }

      applicant.lookupObject(info)
        .done(function (obj) {
          var text = obj.parsed.data.message
          t.equal(utils.parseSimpleMsg(text).type, nextFormType, 'got ' + nextFormType)
          defer.resolve()
        })
    }
  }

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
}

function runSetup (setup) {
  test('setup ' + setup.name, function (t) {
    initCount++
    setup.init()
      .then(function () {
        // var everyone = getTims()
        // var bankTims = BANKS.map(function (b) { return b.tim })

        APPLICANT.watchAddresses(constants.IDENTITY_PUBLISH_ADDRESS)
        BANKS.forEach(function (b) {
          b.tim.watchAddresses(constants.IDENTITY_PUBLISH_ADDRESS)
          b.tim.publishMyIdentity().done()
        })

        var defer = Q.defer()
        // each bank + applicant unchains each bank
        var togo = (BANKS.length + 1) * BANKS.length

        getTims().forEach(function (tim) {
          tim.on('unchained', onUnchainedOne)
        })

        function onUnchainedOne (info) {
          if (--togo === 0) {
            defer.resolve()
          }
        }

        return defer.promise
          .then(() => {
            getTims().forEach(tim => {
              tim.removeListener('unchained', onUnchainedOne)
            })
          })
      })
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
  return testUtils.buildNode(extend(COMMON_OPTS, {
    pathPrefix: opts.identity.name() + initCount,
    syncInterval: 0,
    unchainThrottle: 0,
    chainThrottle: 0,
    sendThrottle: 0,
    keeper: testUtils.newKeeper(sharedKeeper)
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
      return Q.all(getTims().map(function (tim) {
        return tim.destroy()
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
    blockchain: clone(applicantWallet.blockchain),
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

  BANKS = BANK_BOTS.map(function (rep, i) {
    var port = BASE_PORT++
    var dht = new DHT(dhtConf)
    dht.listen(port)

    var messenger = newMessenger({
      keys: rep.priv,
      identityJSON: rep.pub,
      port: port,
      dht: dht
    })

    var tim = buildNode({
      dht: dht,
      blockchain: clone(applicantWallet.blockchain),
      identity: Identity.fromJSON(rep.pub),
      keys: rep.priv,
      port: port,
      messenger: messenger,
      _send: messenger.send.bind(messenger)
    })

    var bank = new Bank({
      tim: tim,
      name: 'Bank ' + i,
      path: getNextBankPath(),
      leveldown: memdown,
      productList: testProductList,
      manual: true
    })

    messenger.on('message', bank.receiveMsg)
    return bank
  })

  return Q.all(getTims().map(function (t) {
    return t.ready()
  }))
}

function getNextBankPath () {
  return 'storage' + pathCounter++
}

function initHTTP () {
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

  BANKS = BANK_BOTS.map(function (rep, i) {
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
      messenger: httpServer,
      _send: httpServer.send.bind(httpServer)
    })

    var bank = new Bank({
      tim: tim,
      manual: true,
      name: 'Bank ' + i,
      path: getNextBankPath(),
      productList: testProductList,
      leveldown: memdown
    })

    httpServer.receive = function () {
      var args = [].slice.call(arguments)
      args[2] = true // requires sync response
      return bank.receiveMsg.apply(bank, args)
    }

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

function initWebsockets (bankOpts) {
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
    port: aPort,
    _send: applicantClient.send.bind(applicantClient)
  })

  applicantClient.on('message', APPLICANT.receiveMsg)

  BANKS = BANK_BOTS.map(function (rep, i) {
    var port = BASE_PORT++
    var client = new WebSocketClient({
      url: relayURL,
      otrKey: getDSAKey(rep.priv),
    })

    var tim = buildNode({
      dht: false,
      blockchain: applicantWallet.blockchain,
      identity: Identity.fromJSON(rep.pub),
      keys: rep.priv,
      port: port,
      messenger: client,
      _send: client.send.bind(client)
    })

    var bank = new Bank(extend({
      tim: tim,
      manual: true,
      name: 'Bank ' + i,
      path: getNextBankPath(),
      productList: testProductList,
      leveldown: memdown
    }, bankOpts || {}))

    client.on('message', function (buf, senderInfo) {
      bank.receiveMsg(buf, senderInfo).done()
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

function newFakeData (model) {
  model = typeof model === 'string'
    ? MODELS_BY_ID[model]
    : model

  if (!model) throw new Error('model not found')

  const type = model.id
  const data = {
    [TYPE]: type
  }

  const props = model.required || Object.keys(model.properties)
  props.forEach(name => {
    if (name.charAt(0) === '_' || name === 'from' || name === 'to') return

    data[name] = fakeValue(model, name)
  })

  return data
}

function fakeValue (model, propName) {
  const prop = model.properties[propName]
  const type = prop.type
  switch (type) {
    case 'string':
      return crypto.randomBytes(32).toString('hex')
    case 'number':
      return Math.random() * 100 | 0
    case 'date':
      return Date.now()
    case 'object':
      if (prop.ref === 'tradle.Money') {
        return {
          "value": "6000",
          "currency": "€"
        }
      } else {
        return 'blah'
      }
    case 'boolean':
      return Math.random() < 0.5
    case 'array':
      return [newFakeData(prop.items.ref || prop.items)]
    default:
      throw new Error(`unknown property type: ${type} for property ${propName}`)
  }
}
