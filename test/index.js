'use strict'

// var LOG = require('why-is-node-running')
// require('q-to-bluebird')
// require('@tradle/multiplex-utp')

var crypto = require('crypto')
// var constants = require('@tradle/constants')
// for now
// constants.TYPES.GET_MESSAGE = 'tradle.getMessage'
// constants.TYPES.GET_HISTORY = 'tradle.getHistory'

// overwrite models for tests
var MODELS = require('@tradle/models')
if (MODELS.every(m => m.id !== 'tradle.NextFormRequest')) {
  MODELS.push({
    "id": "tradle.NextFormRequest",
    "type": "tradle.Model",
    "title": "Next Form Request",
    "interfaces": [
      "tradle.Message"
    ],
    "properties": {
      "_t": {
        "type": "string",
        "readOnly": true
      },
      "after": {
        "type": "string",
        "readOnly": true,
        "displayName": true
      }
    }
  })
}

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
var VERIFICATION = 'tradle.Verification'
// var DEFAULT_AWAIT_OPTS = {
//   awaitVerification: true,
//   awaitConfirmation: true
// }

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
Q.longStackSupport = true
var extend = require('xtend')
var clone = require('clone')
var find = require('array-find')
var memdown = require('memdown')
var DSA = require('@tradle/otr').DSA
var protocol = require('@tradle/protocol')
var constants = protocol.constants
var TYPE = constants.TYPE
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var testUtils = require('./utils')
var getCoords = testUtils.getCoords
var testHelpers = require('@tradle/engine/test/helpers')
var tradle = require('@tradle/engine')
var tradleUtils = tradle.utils
tradle.sender.DEFAULT_BACKOFF_OPTS = tradle.sealer.DEFAULT_BACKOFF_OPTS = {
  initialDelay: 100,
  maxDelay: 1000
}

var utils = require('../lib/utils')
var Bank = require('../simple')
Bank.ALLOW_CHAINING = true
var users = require('./fixtures/users')
users.forEach(u => {
  if (!u[ROOT_HASH]) u[ROOT_HASH] = u[CUR_HASH]
})

var applicantInfo = users.pop()
var applicantName = applicantInfo.profile.name.formatted
var applicantKeys = applicantInfo.keys
var applicantIdentity = applicantInfo.identity
var types = require('../lib/types')
var FORM_REQUEST = 'tradle.FormRequest'
var multiEntryProduct = require('./fixtures/multi-entry')
// var testHelpers = require('@tradle/test-helpers')
// var Keeper = require('offline-keeper')
// var FakeKeeper = testHelpers.fakeKeeper
// var createFakeWallet = testHelpers.fakeWallet
var NETWORK_NAME = 'testnet'
var BASE_PORT = 22222
var bootstrapDHT
var pathCounter = 0
var initCount = 0
//// var nonce = 0

var COMMON_OPTS = {
  leveldown: memdown,
  // TODO: test without shared keeper
  // keeper: sharedKeeper,
  // keeper: new Keeper({
  //   storage: 'keeperStorage'
  // }),
  networkName: NETWORK_NAME,
  ip: '127.0.0.1',
  syncInterval: 100
}

// var applicant
// var BANK_SERVER
// var WEBSOCKET_RELAY

// 2 banks, 3 personnel each (1 bot + 2 employees)
var BANK_PERSONNEL = new Array(2).fill(null).map(function (n, i) {
  return users.slice(i * 3, i * 3 + 3) // 3 per bank
})

test.skip('models', function (t) {
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

testForwarding()
testMultiEntry()
testCustomProductConfirmation()
testGuestSession()
testRemediation()
testManualMode()

runTests(init)
// Object.keys(setups).forEach(name => runTests(setups[name]))

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
//   banks = []
//   applicant = null
//   var setup = {
//     name: 'websockets',
//     init: initWebsockets
//   }

//   runSetup(setup)

//   test('semi-manual mode', function (t) {
//     var bank = banks[0]
//     bank._auto.verify = false

//     var bankCoords = getCoords(bank.tim)
//     var product = 'tradle.CurrentAccount'
//     var approved = false
//     var confirmed = false
//     var helpers = getHelpers({
//       applicant: applicant,
//       bank: bank,
//       forms: {},
//       verifications: {},
//       setup: setup,
//       t: t
//     })

//     helpers.sendIdentity()
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
//           customerRootHash: applicant.myRootHash(),
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
//   banks = []
//   applicant = null
//   var setup = {
//     name: 'websockets',
//     init: initWebsockets
//   }

//   runSetup(setup)

//   test('manual mode (confirmation triggers verifications)', function (t) {
//     var bank = banks[0]
//     bank._auto.approve = false
//     bank._auto.verify = false

//     var bankCoords = getCoords(bank.tim)
//     var product = 'tradle.CurrentAccount'
//     var approved = false
//     var confirmed = false
//     var helpers = getHelpers({
//       applicant: applicant,
//       bank: bank,
//       forms: {},
//       verifications: {},
//       setup: setup,
//       t: t
//     })

//     helpers.sendIdentity()
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
//           customerRootHash: applicant.myRootHash(),
//           productType: product
//         })
//       })
//       .done(() => approved = true)

//     let verificationsTogo = 3
//     applicant.on('message', info => {
//       if (info[TYPE] !== VERIFICATION) return

//       applicant.lookupObject(info)
//         .then(obj => {
//           verificationsTogo--
//           t.pass('got verification for ' + obj.object.object.document.id)
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

function testForwarding () {
  test('forward message', t => {
    var setup
    runSetup(init)
      .then(_setup => {
        setup = _setup
        return Q.ninvoke(testHelpers, 'meet', setup.tims)
      })
      .then(() => {
        var banks = setup.banks
        var applicant = setup.applicant
        var a = banks[0]
        var b = banks[1]

        var helpers = getHelpers({
          applicant: applicant,
          bank: a,
          banks: banks,
          forms: {},
          verifications: {},
          setup: setup,
          t: t
        })

        const product = 'tradle.CurrentAccount'
        // Q.all(banks.map(bank => bank.tim.addContactIdentity(applicant.identity)))
        //   .done(() => {
            helpers.signNSend({
              [TYPE]: 'tradle.ProductApplication',
              _to: b.tim.permalink,
              product: product
            })
          // })

        const send = a.tim._send
        let sent
        a.tim._send = function (msg, recipient, cb) {
          sent = msg
          return send.apply(this, arguments)
        }

        var receiveDefer = Q.defer()
        b.receiveMsg = function (msg, from) {
          t.same(msg, sent)
          receiveDefer.resolve()
          return Q()
        }

        return receiveDefer.promise
      })
      .then(() => teardown(setup))
      .done(() => t.end())
  })
}

function testMultiEntry () {
  test('multi entry forms', t => {
    runSetup(init).then(setup => {
      var banks = setup.banks
      var applicant = setup.applicant

      var bank = banks[0]
      var bankCoords = getCoords(bank.tim)
      var productModel = multiEntryProduct
      var product = multiEntryProduct.id
      bank._models = utils.processModels([productModel])
      bank._productList.push(product)
      MODELS_BY_ID[product] = productModel

      var multi = productModel.forms[0]
      if (productModel.multiEntryForms.indexOf(multi) !== 0) {
        throw new Error('invalid fixtures')
      }

      var productForms = productModel.forms
      var forms = {}
      var helpers = getHelpers({
        applicant: applicant,
        bank: bank,
        banks: banks,
        forms: forms,
        verifications: {},
        setup: setup,
        t: t
      })

      helpers.sendIdentity({ awaitUnchained: true })
        .then(() => helpers.startApplication(product))
        .then(() => helpers.sendForm({
          form: multi,
          nextForm: multi
        }))
        .then(() => helpers.sendForm({
          form: multi,
          nextForm: multi
        }))
        .then(() => helpers.sendNextFormRequest({
          after: multi,
          nextForm: productModel.forms[1]
        }))
        .then(() => helpers.sendForm({
          form: productModel.forms[1]
        }))
        .done()

      Q.all([
          helpers.awaitVerification(3),
          helpers.awaitType(product + 'Confirmation')
        ])
        .then(() => teardown(setup))
        .done(function () {
          t.end()
        })
    })
    .done()
  })
}

function testCustomProductConfirmation () {
  test('custom product confirmation', t => {
    runSetup(init).then(setup => {
      var banks = setup.banks
      var applicant = setup.applicant

      var bank = banks[0]
      var bankCoords = getCoords(bank.tim)
      var product = 'tradle.MortgageProduct'
      var productModel = MODELS[product]
      var productForms = productModel.forms
      var forms = {}
      var helpers = getHelpers({
        applicant: applicant,
        bank: bank,
        banks: banks,
        forms: forms,
        verifications: {},
        setup: setup,
        t: t
      })

      helpers.sendIdentity({ awaitUnchained: true })
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
        .then(() => teardown(setup))
        .done(function () {
          t.end()
        })
    })
    .done()
  })
}

function testGuestSession () {
  test('import guest session', function (t) {
    runSetup(init).then(setup => {
      const banks = setup.banks
      const applicant = setup.applicant
      var bank = banks[0]
      var bankCoords = getCoords(bank.tim)
      var product = 'tradle.CurrentAccount'
      var forms = {}
      var helpers = getHelpers({
        applicant: applicant,
        bank: bank,
        banks: banks,
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
//          [NONCE]: '' + (nonce++),
          time: 10000,
          document: {
            [TYPE]: YOUR_MONEY
          }
        }
      ]

      bank.storeGuestSession(sessionHash, session)
        .then(() => helpers.sendIdentity({ awaitUnchained: true }))
        .then(() => helpers.sendSessionIdentifier(sessionHash, 'tradle.FormError'))
        .then(wrapper => {
          const errors = wrapper.object.object.errors
          t.ok(errors.some(e => e.name === missing))
          incompleteAboutYou[missing] = missingVal
          helpers.signNSend(incompleteAboutYou)
          return helpers.awaitType('tradle.FormError')
        })
        .then(wrapper => {
          const message = wrapper.object.object.message
          t.ok(/review/.test(message))
          helpers.signNSend(yourMoney)
          return helpers.awaitType('tradle.FormError')
        })
        .then(wrapper => {
          const message = wrapper.object.object.message
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
          const yourMoneyV = find(verifications, v => {
            return v.object.object.document.id.split('_')[0] === YOUR_MONEY
          })

          t.equal(yourMoneyV.object.object.backDated, 10000)
          return teardown(setup)
        })
        .done(function () {
          t.end()
        })
    })
  })
}

function testRemediation () {
  test('import remediation', function (t) {
    runSetup(init).then(setup => {
      const banks = setup.banks
      const applicant = setup.applicant
      var bank = banks[0]
      var bankCoords = getCoords(bank.tim)
      var product = 'tradle.Remediation'
      var forms = {}
      var helpers = getHelpers({
        applicant: applicant,
        bank: bank,
        banks: banks,
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
//          [NONCE]: '' + (nonce++),
          time: 10000,
          document: {
            [TYPE]: YOUR_MONEY
          }
        }
      ]

      const verified = helpers.awaitVerification(3)
        .then(verifications => {
          const yourMoneyV = find(verifications, v => {
            return v.object.object.document.id.split('_')[0] === YOUR_MONEY
          })

          t.equal(yourMoneyV.object.object.backDated, 10000)
        })

      bank.storeGuestSession(sessionHash, session)
        .then(() => helpers.sendIdentity({ awaitUnchained: true }))
        .then(() => helpers.sendSessionIdentifier(sessionHash, types.FORM_ERROR))
        .then(wrapper => {
          const message = wrapper.object.object.message
          t.ok(/review/.test(message))
          helpers.signNSend(aboutYou)
          return helpers.awaitType(types.FORM_ERROR)
        })
        .then(wrapper => {
          const message = wrapper.object.object.message
          t.ok(/review/.test(message))
          helpers.signNSend(yourMoney)
          return helpers.awaitType(types.FORM_ERROR)
        })
        .then(wrapper => {
          const message = wrapper.object.object.message
          t.ok(/review/.test(message))
          helpers.signNSend(license)
          return helpers.awaitType(types.SIMPLE_MESSAGE)
        })
        .then(msg => {
          t.ok(/confirm/.test(msg.object.object.message))
          return verified
        })
        .then(() => teardown(setup))
        .done(function () {
          t.end()
        })
    })
  })
}

function testManualMode () {
  test('manual verifications + confirmation', function (t) {
    runSetup(init).then(setup => {
      const banks = setup.banks
      const applicant = setup.applicant
      var bank = banks[0]
      bank._auto.verify = false

      var bankCoords = getCoords(bank.tim)
      var product = 'tradle.CurrentAccount'
      var forms = {}
      var approved = false
      var helpers = getHelpers({
        applicant: applicant,
        bank: bank,
        banks: banks,
        forms: forms,
        verifications: {},
        setup: setup,
        t: t
      })

      helpers.sendIdentity({ awaitUnchained: true })
        .then(() => helpers.startApplication(product))
        .then(() => helpers.sendForm({ form: ABOUT_YOU, awaitVerification: false }))
        .then(() => {
          // should fail
          return bank.approveProduct({
            customerRootHash: applicant.myRootHash(),
            productType: product
          })
        })
        .then(() => t.fail('approval should not be possible without requisite forms'))
        .catch(err => t.pass('approval prevented without required forms'))
        .then(() => helpers.sendForm({ form: YOUR_MONEY, awaitVerification: false }))
        .then(() => helpers.sendForm({ form: LICENSE, awaitVerification: false, awaitConfirmation: false }))
        // delay to make sure no auto-confirmation happens
        .then(() => console.log('patience...'))
        .then(() => Q.Promise(resolve => setTimeout(resolve, 1000)))
        .then(() => {
          // should fail
          return bank.approveProduct({
            customerRootHash: applicant.permalink,
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
            customerRootHash: applicant.permalink,
            productType: product
          })
        })
        .done(() => approved = true)

      let verificationsTogo = 3
      applicant.on('message', wrapper => {
        if (wrapper.object.object[TYPE] !== VERIFICATION) return

        t.equal(--verificationsTogo >= 0, true)
        t.pass('got verification for ' + wrapper.object.object.document.id.split('_')[0])
      })

      helpers.awaitConfirmation()
        .then(() => {
          t.equal(approved, true)
          t.equal(verificationsTogo, 0)
          return teardown(setup)
        })
        .done(function () {
          t.end()
        })
    })
  })
}

function runTests (setupFn, idx) {
  test('current account', function (t) {
    var setup
    runSetup(setupFn).then(_setup => {
      setup = _setup
      return Q.ninvoke(testHelpers, 'meet', setup.banks.map(b => b.tim))
    })
    .then(() => {
      const banks = setup.banks
      const applicant = setup.applicant
      var bank
      var bankCoords
      var forms
      var verifications
      var verificationsTogo
      var verificationsDefer
      var helpers

      cleanCache()

      applicant.on('readseal', onReadSeal)
      // tryUnacquainted() // TODO: get this working
      Q()
        .then(runBank1Scenario)
        // .then(runBank2Scenario)
        .then(function () {
          changeBank(banks[0])
          console.log('exercising right to be forgotten')
          return helpers.forget()
        })
        .then(function () {
          cleanCache()
          return runBank1Scenario(true)
        })
        // .then(dumpDBs.bind(null, banks[0]))
        .then(() => teardown(setup))
        .done(() => t.end())

      function changeBank (newBank) {
        bank = newBank
        bankCoords = getCoords(bank.tim)
        helpers = getHelpers({
          applicant: applicant,
          bank: bank,
          banks: banks,
          forms: forms,
          verifications: verifications,
          setup: setup,
          t: t
        })
      }

      function runBank1Scenario (secondTime) {
        changeBank(banks[0])
        helpers.awaitVerification(3).then(wrappers => {
          return wrappers.map(v => {
            return applicant.watchSeal({
              link: protocol.linkString(v.object.object),
              basePubKey: bank.tim.chainPubKey
            })
          })
        })
        .done()

        const sendIdentity = secondTime
          ? helpers.sendIdentityAgain()
          : helpers.sendIdentity({ awaitUnchained: !secondTime })
              // bank shouldn't publish you twice
              .then(() => helpers.sendIdentityAgain())

        return sendIdentity
          .then(() => helpers.startApplication())
          .then(() => helpers.sendForm({ form: ABOUT_YOU, nextForm: YOUR_MONEY }))
          .then(() => helpers.sendForm({ form: YOUR_MONEY, nextForm: LICENSE }))
          .then(helpers.sendIncompleteLicense)
          .then(() => helpers.sendForm({ form: LICENSE }))
          .then(function () {
            return verificationsDefer.promise
          })
      }

      function runBank2Scenario () {
        changeBank(banks[1])
        return helpers.sendIdentity({ awaitUnchained: true })
          .then(() => helpers.startApplication())
          .then(() => helpers.shareFormAndVerification({ form: ABOUT_YOU, nextForm: YOUR_MONEY }))
          .then(() => helpers.shareFormAndVerification({ form: YOUR_MONEY, nextForm: LICENSE }))
          .then(() => helpers.shareFormAndVerification({ form: LICENSE, awaitConfirmation: true }))
      }

      function cleanCache () {
        forms = {}
        verifications = {}
        verificationsTogo = 3
        verificationsDefer = Q.defer()
      }

      function onReadSeal (wrapper) {
        if (wrapper.object[TYPE] !== VERIFICATION) {
          return
        }

        var documentHash = wrapper.object.document.id.split('_')[1]
        return Q.ninvoke(applicant.objects, 'get', documentHash, true)
          .then(function (docWrapper) {
            var vType = docWrapper.object[TYPE]
            verifications[vType] = wrapper.link
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
  })
}

function getHelpers (opts) {
  typeforce({
    applicant: 'Object',
    banks: 'Array',
    bank: 'Object',
    forms: 'Object',
    verifications: 'Object',
    setup: 'Object',
    t: 'Object'
  }, opts)

  const applicant = opts.applicant
  const banks = opts.banks
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
    // sendAboutYou,
    // sendYourMoney,
    // sendLicense,
    sendNextFormRequest,
    sendIncompleteLicense,
    // shareAboutYouVer,
    // shareYourMoneyVer,
    // shareLicenseVer,
    forget,
    signNSend,
    shareForm,
    shareFormAndVerification,
    shareVerification,
    awaitForm,
    awaitVerification,
    awaitType,
    awaitConfirmation,
    awaitTypeUnchained
  }

  function sendIdentity (opts) {
    opts = opts || {}
    signNSend({
      [TYPE]: types.IDENTITY_PUBLISH_REQUEST,
      identity: applicant.identity
    })

    if (opts.awaitUnchained) {
      applicant.watchSeal({
        link: protocol.linkString(applicant.identity),
        basePubKey: bank.tim.chainPubKey
      })
      .done()
    }

    return Q.all([
        opts.awaitUnchained && awaitTypeUnchained(types.IDENTITY, applicant),
        // awaitTypeUnchained(types.IDENTITY, banks[0].tim),
        // awaitTypeUnchained(types.IDENTITY, banks[1].tim),
        awaitType('tradle.IdentityPublished')
      ])
      .then(function () {
        t.pass('customer\'s identity was published')
      })
  }

  function sendIdentityAgain () {
    signNSend({
      nonce: 1,
      [TYPE]: types.IDENTITY_PUBLISH_REQUEST,
      identity: applicant.identity
    })
    .done()

    return awaitMessage(msg => {
        return /already/.test(msg.object.object.message)
      })
      .then(function () {
        t.pass('customer\'s identity was not published twice')
      })
  }

  function sendSessionIdentifier (identifier, waitType) {
    var msg = {
      [TYPE]: types.GUEST_SESSION_PROOF,
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
      [TYPE]: types.SIMPLE_MESSAGE,
//      [NONCE]: '' + nonce++,
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
    sendForm(extend(opts || {}, {
      form: ABOUT_YOU
    }))
  }

  function sendYourMoney (opts) {
    sendForm(extend(opts || {}, {
      form: YOUR_MONEY
    }))
  }

  function sendLicense (opts) {
    sendForm(extend(opts || {}, {
      form: LICENSE
    }))
  }

  // function sendMortgageLoanDetail (opts) {
  //   opts = opts || DEFAULT_AWAIT_OPTS
  //   return sendForm(extend({
  //     form: MORTGAGE_LOAN_DETAIL
  //   }, DEFAULT_AWAIT_OPTS))
  // }

  function sendNextFormRequest (opts) {
    signNSend({
      [TYPE]: 'tradle.NextFormRequest',
      after: opts.after
    })

    return Q.all([
      opts.nextForm && awaitForm(opts.nextForm)
    ])
  }

  function sendForm (opts) {
    typeforce({
      form: 'String'
    }, opts)

    const form = opts.form
    signNSend(newFakeData(form))
      .then(result => {
        return applicant.watchSeal({
          link: result.object.link,
          basePubKey: bank.tim.chainPubKey
        })
      })
      .done()

    return Q.all([
        opts.nextForm && awaitForm(opts.nextForm),
        awaitTypeUnchained(form),
        opts.awaitVerification && awaitVerification(),
        opts.awaitConfirmation && awaitConfirmation()
      ])
      .then(function () {
        if (opts.nextForm) t.pass('got next form: ' + opts.nextForm)
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
    signNSend({
      [TYPE]: LICENSE,
      licenseNumber: 'abc',
      dateOfIssue: 1414342441249
    })

    return awaitType('tradle.FormError')
  }

  // function shareAboutYouVer () {
  //   shareForm(ABOUT_YOU)
  //     .then(function () {
  //       shareVerification(ABOUT_YOU)
  //     })

  //   return Q.all([
  //     awaitForm(YOUR_MONEY),
  //     awaitTypeUnchained(VERIFICATION)
  //   ])
  // }

  function shareFormAndVerification (opts) {
    const form = opts.form
    const share = shareForm(form).then(() => shareVerification(form))
    applicant.watchSeal({
      link: verifications[form],
      basePubKey: bank.tim.chainPubKey
    })
    .done()

    return Q.all([
      share,
      awaitTypeUnchained(VERIFICATION),
      opts.nextForm && awaitForm(opts.nextForm),
      opts.awaitConfirmation && awaitConfirmation()
    ])

  }

  // function shareYourMoneyVer () {
  //   const share = shareForm(YOUR_MONEY).then(() => shareVerification(YOUR_MONEY))
  //   applicant.watchSeal({
  //     link: verifications[YOUR_MONEY],
  //     basePubKey: bank.tim.chainPubKey
  //   })
  //   .done()

  //   return Q.all([
  //     share,
  //     awaitForm(LICENSE),
  //     awaitTypeUnchained(VERIFICATION)
  //   ])
  // }

  // function shareLicenseVer () {
  //   shareForm(LICENSE)
  //     .then(function () {
  //       shareVerification(LICENSE)
  //     })

  //   return Q.all([
  //     awaitConfirmation(),
  //     awaitTypeUnchained(VERIFICATION)
  //   ])
  // }

  function forget () {
    var msg = {
      reason: 'none of your business'
    }

//    msg[NONCE] = '' + (nonce++)
    msg[TYPE] = types.FORGET_ME
    signNSend(msg)
    return awaitType(types.FORGOT_YOU)
      .then(() => applicant.forget(bank.tim.permalink))
  }

  function signNSend (msg, opts) {
    return applicant.signAndSend({
      object: msg,
      to: bankCoords
    })
    .then(result => {
      const type = result.object.object[TYPE]
      if (MODELS_BY_ID[type].subClassOf === 'tradle.Form' || CurrentAccount.forms.indexOf(type) !== -1) {
        forms[type] = result.object.permalink
      }

      return result
    })
  }

  function shareForm (type) {
    return applicant.send({ link: forms[type], to: bankCoords })
  }

  function shareVerification (type) {
    return applicant.send({ link: verifications[type], to: bankCoords })
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

  function awaitMessage (test, n) {
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

    function onmessage (msg) {
      if (test(msg)) {
        t.pass('received message: ' + msg.object.object[TYPE])
        received.push(msg)
        if (--togo === 0) defer.resolve(n === 1 ? received[0] : received)
      }
    }
  }

  function awaitType (type, n) {
    return awaitMessage(msg => msg.object.object[TYPE] === type, n)
  }

  function awaitTypeUnchained (type, tim) {
    var defer = Q.defer()
    tim = tim || applicant
    tim.on('readseal', unchainedHandler)
    return defer.promise
      .then(function () {
        tim.removeListener('readseal', unchainedHandler)
      })

    function unchainedHandler (wrapper) {
      if (wrapper.object[TYPE] === type) {
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

    function onmessage (msg) {
      if (msg.object.object[TYPE] !== FORM_REQUEST) {
        return
      }

      var form = msg.object.object.form
      t.equal(form, nextFormType, 'got ' + nextFormType)
      defer.resolve()
    }
  }

  // test('wipe and recover', function (t) {
  //   var backup
  //   var bank = banks[0]
  //   var bankCoords = {}
  //   bankCoords[ROOT_HASH] = bank.tim.myRootHash()
  //   var options = applicant.options()
  //   applicant.history(bankCoords)
  //     .then(function (msgs) {
  //       backup = msgs
  //       return applicant.destroy()
  //     })
  //     .then(function () {
  //       applicant = new Tim(options)
  //       return applicant.ready()
  //     })
  //     .then(function () {
  //       applicant.on('message', oneDown)

  //       var msg = {}
  //       msg[TYPE] = constants.TYPES.GET_HISTORY
//        // msg[NONCE] = '' + nonce++
  //       return applicant.send({
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
  //       applicant.removeListener('message', oneDown)
  //       t.end()
  //     }
  //   }
  // })
}

function runSetup (init) {
  const defer = Q.defer()
  initCount++
  let result
  return init()
  // .then(function (_result) {
  //   result = _result
  //   const applicant = utils.promisifyNode(result.applicant)
  //   const banks = result.banks
  //   // var everyone = getTims()
  //   // var bankTims = banks.map(function (b) { return b.tim })

  //   var tims = result.tims
  //   // tims.forEach(tim => tim.watchAddresses(constants.IDENTITY_PUBLISH_ADDRESS))
  //   // banks.forEach(function (b) {
  //   //   b.tim.publishMyIdentity().done()
  //   // })

  //   var defer = Q.defer()
  //   // each bank + applicant unchains each bank
  //   var togo = tims.length * banks.length

  //   tims.forEach(function (tim) {
  //     tim.on('readseal', onReadSealOne)
  //   })

  //   function onReadSealOne (info) {
  //     // console.log(this.myRootHash(), info[ROOT_HASH])
  //     if (--togo === 0) {
  //       defer.resolve()
  //     }
  //   }

  //   return defer.promise
  //     .then(() => {
  //       tims.forEach(tim => {
  //         tim.removeListener('readseal', onReadSealOne)
  //       })
  //     })
  // })
  // .then(() => result)
}

function buildNode (opts) {
  return testUtils.buildNode(extend(COMMON_OPTS, {
    pathPrefix: getPathPrefix(opts),
    identity: opts.user && opts.user.pub,
    keys: opts.user && opts.user.priv,
    syncInterval: 0,
    // unchainThrottle: 0,
    // chainThrottle: 0,
    // sendThrottle: 0
  }, opts))
}

function teardown (setup) {
  // if (setup.relay) setup.relay.destroy()
  // if (setup.server) setup.server.close()

  const tims = getTims(setup)
  return Q.all(setup.banks.map(function (bank) {
      return bank.destroy()
    }))
    .then(function () {
      return Q.all(tims.map(function (t) {
        return t.messenger && t.messenger.destroy()
      }))
    })
    .then(function () {
      return Q.all(tims.map(function (tim) {
        return Q.ninvoke(tim, 'destroy')
      }))
    })
}

function getTims (setup) {
  return setup.tims
}

function getNextBankPath () {
  return 'storage' + pathCounter++
}

function createNode (opts) {
  return testHelpers.createNode(extend(COMMON_OPTS, opts))
}

function init (bankOpts) {
  var applicant = createNode({
    // dir: JSON.stringify(applicantInfo.profile.name).replace(/[^a-zA-Z0-9]/g, ''),
    dir: applicantKeys[0].fingerprint + initCount,
    keys: applicantKeys,
    identity: applicantIdentity,
    name: 'APPLICANT'
  })

  var tims = [applicant]
  var banks = BANK_PERSONNEL.map(function (personnel, i) {
    var port = BASE_PORT++
    var employees = personnel.slice(1).map(e => {
      return utils.pick(e, 'identity', 'profile', CUR_HASH, ROOT_HASH)
    })

    // console.log('employees: ' + employees.map(e => e[ROOT_HASH]).join(', '))
    // console.log('bot: ' + personnel[0][ROOT_HASH])
    var botName = 'Bank ' + i
    var personnelNodes = personnel.map(function (rep, j) {
      return createNode({
        blockchain: applicant.blockchain,
        identity: rep.identity,
        keys: rep.keys,
        name: j ? rep.profile.name.formatted : botName
      })
    })

    var bot = personnelNodes[0]
    var bank = new Bank(extend({
      node: bot,
      manual: true,
      name: botName,
      path: getNextBankPath(),
      productList: testProductList,
      leveldown: memdown,
      employees: employees
    }, bankOpts || {}))

//     bot.on('message', bank.receiveMsg)

    // var addBank = Q.all(personnelNodes.map(node => {
    //   return node.addContactIdentity(bot.identity)
    // }))

    // var addEmployees = Q.all(employees.map(e => {
    //   return bank.tim.addContactIdentity(e.identity)
    // }))

    tims = tims.concat(personnelNodes).map(utils.promisifyNode)
    return bank
    // return Q.all([
    //   addBank,
    //   addEmployees
    // ])
    // .then(() => bank)
  })

  tims.forEach(tim => {
    tim._send = function (msg, recipient, cb) {
      const myInfo = { permalink: tim.permalink }
      if (recipient.permalink === applicant.permalink) {
        return applicant.receive(msg, myInfo, cb)
      }

      const recipientBank = find(banks, b => b.tim.permalink === recipient.permalink)
      if (recipientBank) return recipientBank.receiveMsg(msg, myInfo).nodeify(cb)

      const fallback = find(tims, tim => tim.permalink === recipient.permalink)
      if (fallback) return fallback.receive(msg, myInfo, cb)

      throw new Error('unable to find recipient')
    }
  })

  const setup = {
    applicant,
    banks,
    tims
  }

//   applicant._send = function (msg, recipient, cb) {
//     const myInfo = { link: applicant.link }
//     const recipientBank = find(banks, b => b.tim.link === recipient.link)
//     if (recipientBank) return recipientBank.receiveMsg(msg, myInfo).nodeify(cb)
//     else debugger
//   }

  return Q.all(banks.map(bank => {
    return applicant.addContact(bank.tim.identity)
  }))
  .then(() => setup)

  // testHelpers.connect(tims)
  // return Q(setup)
  // return Q.all([
  //     Q.ninvoke(testHelpers, 'meet', tims)
  //   ])
  //   .then(() => setup)
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

function getPathPrefix (opts) {
  if (opts.user) {
    var name = opts.user.profile.name
    return name.firstName + name.lastName + initCount
  }

  return opts.identity.name.formatted + initCount
}
