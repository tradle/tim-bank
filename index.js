require('multiplex-utp')

var path = require('path')
var debug = require('debug')('bank')
var extend = require('xtend')
var levelup = require('levelup')
var typeforce = require('typeforce')
var tutils = require('tradle-utils')
var utils = require('./lib/utils')
var Q = require('q')
var constants = require('tradle-constants')
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var TYPE = constants.TYPE
var OWNER = constants.OWNER
var NONCE = constants.NONCE
var types = constants.TYPES
// var types = require('./lib/types')
var MODELS = require('./lib/models')
var MODELS_BY_ID = {}
MODELS.getModels().forEach(function (m) {
  MODELS_BY_ID[m.id] = m
})

module.exports = Bank

function Bank (options) {
  var self = this

  typeforce({
    tim: 'Object',
    path: 'String',
    leveldown: 'Function'
  }, options)

  tutils.bindPrototypeFunctions(this)

  var tim = this._tim = options.tim
  this.wallet = tim.wallet

  tim.on('error', function (err) {
    self._debug('error', err)
  })

  tim.on('message', function (info) {
    tim.lookupObject(info)
      .done(self._onMessage)
  })

  var readyDefer = Q.defer()
  this._readyPromise = readyDefer.promise

  tim.once('ready', function () {
    self._ready = true
    readyDefer.resolve()
    // printIdentityStatus(tim)
    //   .then(dumpDBs.bind(null, tim))
  })

  this._db = levelup(options.path, {
    db: options.leveldown,
    valueEncoding: 'json'
  })
}

Bank.prototype._getCustomerState = function (customerRootHash) {
  return Q.ninvoke(this._db, 'get', prefixKey(types.IDENTITY, customerRootHash))
}

Bank.prototype._setCustomerState = function (customerRootHash, state) {
  return Q.ninvoke(this._db, 'put', prefixKey(types.IDENTITY, customerRootHash), state)
}

Bank.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this._tim.name())
  return debug.apply(null, args)
}

Bank.prototype._onMessage = function (obj) {
  var self = this
  if (!this._ready) {
    return this._readyPromise.then(this._onMessage.bind(this, obj))
  }

  var state
  this._getCustomerState(obj.from[ROOT_HASH])
    .catch(function (err) {
      if (!err.notFound) throw err

      return newCustomerState()
    })
    .then(function (_state) {
      return state = _state
    })
    .then(this._onMessageFromCustomer.bind(this, obj))
    .then(function () {
      return self._setCustomerState(obj.from[ROOT_HASH], state)
    })
    .done()
}

Bank.prototype._onMessageFromCustomer = function (obj, state) {
  var msgType = obj[TYPE]
  this._debug('received message of type', msgType)

  switch (msgType) {
    case types.SIMPLE_MESSAGE:
      var parsed = utils.parseSimpleMsg(obj.parsed.data.message)
      switch (parsed.type) {
        case 'tradle.CurrentAccounts':
          return this._handleNewApplication(obj, state, parsed.type)
        default:
          break
      }

      break
    case 'tradle.AboutYou':
    case 'tradle.YourMoney':
    case 'tradle.LicenseVerification':
      return this._handleDocument(obj, state)
    case 'tradle.Verification':
      return this._handleVerification(obj, state)
    // case types.CurrentAccountApplication:
    //   return this._handleCurrentAccountApplication(obj)
    // case types.SharedKYC:
    //   return this._handleSharedKYC(obj)
    default:
      this._debug('ignoring message of type', obj[TYPE])
      break
  }
}

Bank.prototype._continue = function (obj, state) {
  var self = this

  return this._chainReceivedMsg(obj)
    .then(function () {
      return self._sendNextFormOrApprove(obj, state)
    })
}

Bank.prototype._handleDocument = function (obj, state) {
  var self = this
  var type = obj[TYPE]
  var docState = state.forms[type] = state.forms[type] || {}
  var verifications = []

  docState.form = obj.parsed.data
  docState.verifications = docState.verifications || []
  // docState[obj[ROOT_HASH]] = {
  //   form: obj.parsed.data,
  //   verifications: verifications
  // }

  // pretend we verified it
  var verification = newVerificationFor(obj)
  docState.verifications.push(verification)

  return this._respond(obj, verification)
    .then(function () {
      return self._continue(obj, state)
    })
}

Bank.prototype._handleVerification = function (obj, state) {
  var verification = obj.parsed.data
  var type = verification.documentType
  var docState = state.forms[type] = state.forms[type] || {}
  // var formHash = verification.document
  // var formState = docState[formHash] = docState[formHash] || {
  //   form: null,
  //   verifications: []
  // }

  docState.verifications = docState.verifications || []
  docState.verifications.push(verification)
  return this._continue(obj, state)
}

Bank.prototype._sendNextFormOrApprove = function (obj, state, productType) {
  var app = obj.parsed.data
  productType = productType ||
    app.productType ||
    Object.keys(state.pendingApplications)[0]

  var productModel = MODELS_BY_ID[productType]
  if (!productModel) return Q.reject('no such product model: ' + productType)

  var reqdForms = productModel.properties.forms.items
  var missing = reqdForms.filter(function (fType) {
    var existing = state.forms[fType]
    if (existing) {
      return !existing.verifications.length
    }

    return true
  })

  var next = missing[0]
  var resp
  if (next) {
    this._debug('requesting form', next)
    resp = utils.buildSimpleMsg(
      'Please fill out this form and attach the snapshot of the original document',
      next
    )

    opts.chain = false
  } else {
    this._debug('approving for product', productType)
    resp = {}
    resp[TYPE] = productType + 'Confirmation'
    resp.message = 'Congratulations! You were approved for a ' + productType
    if (--state.pendingApplications[productType] === 0) {
      delete state.pendingApplications[productType]
    }
  }

  return this._respond(obj, resp, opts)
}

Bank.prototype._handleNewApplication = function (obj, state, productType) {
  var pending = state.pendingApplications
  pending[productType] = pending[productType] || 0
  pending[productType]++ // keep it simple for now
  return this._sendNextFormOrApprove(obj, state, productType)
}

Bank.prototype._chainReceivedMsg = function (app) {
  if (app.chain || app.tx || app.dateUnchained || app[TYPE] === types.VERIFICATION) {
    return Q.resolve()
  }

  // chain message on behalf of customer
  return this._tim.chain({
    msg: app.data,
    to: [getSender(app)]
  })
}

Bank.prototype._getResource = function (type, appHash) {
  return Q.ninvoke(db, 'get', prefixKey(type, appHash))
}

// Bank.prototype._handleDriverLicense = function (license) {
//   var self = this
//   var curHash = license[CUR_HASH]
//   var appHash = license.application

//   // assume valid at this point

//   var resp = {}
//   resp[TYPE] = constants.TYPES.VERIFICATION

//   Q.all([
//     this._chainReceivedMsg(license),
//     this._respond(license, resp)
//   ]).done()
// }

// Bank.prototype._handleCurrentAccountApplication2 = function (app) {
//   var self = this
//   var curHash = app[CUR_HASH]

//   var resp = {}
//   resp[TYPE] = types.CurrentAccountConfirmation

//   Q.all([
//     this._chainReceivedMsg(app),
//     this._respond(app, resp)
//   ]).done()
// }

Bank.prototype._respond = function (req, resp, opts) {
  var self = this
  opts = opts || {}

//   resp[OWNER] = this._tim.myCurrentHash()
  resp.time = Date.now()

  return this._tim.sign(resp)
    .then(function (signed) {
      return self._tim.send(extend({
        to: [getSender(req)],
        msg: signed,
        chain: true,
        deliver: true
      }, opts))
    })
}

// Bank.prototype._handleCurrentAccountApplication = function (app) {
//   var self = this
//   var curHash = app[CUR_HASH]

//   // this simulation clearly takes
//   // financial inclusion very seriously
//   var resp = {
//     application: curHash,
//     status: 'accepted'
//   }

//   resp[TYPE] = types.CurrentAccountConfirmation
//   resp[OWNER] = this._tim.myCurrentHash()

//   var reply = this._tim.sign(resp)
//     .then(function (signed) {
//       return self._tim.send({
//         to: [getSender(app)],
//         msg: signed,
//         chain: true,
//         deliver: true
//       })
//     })

//   Q.all([
//     this._chainReceivedMsg(app),
//     reply
//   ]).done()
// }

// Bank.prototype._handleSharedKYC = function (app) {
//   // same for now
//   return this._handleCurrentAccountApplication(app)
// }

Bank.prototype.destroy = function () {
  if (this._destroyPromise) return this._destroyPromise

  return this._destroyPromise = Q.all([
    this._tim.destroy(),
    Q.ninvoke(this._db, 'close')
  ])
}

function getSender (msg) {
  var sender = {}
  sender[ROOT_HASH] = msg.from[ROOT_HASH]
  return sender
}

function prefixKey(type, key) {
  return type + '!' + key
}

function dumpDBs (tim) {
  var identities = tim.identities()
  identities.onLive(function () {
    identities.createValueStream()
      .on('data', function (result) {
        // console.log('identity', result.identity.name.firstName)
        console.log('identity', result.identity)
      })
  })

  var messages = tim.messages()
  messages.onLive(function () {
    messages.createValueStream()
      .on('data', function (data) {
        tim.lookupObject(data)
          .then(function (obj) {
            console.log('msg', obj[CUR_HASH])
          })
      })
  })
}

function printIdentityStatus (tim) {
  return tim.identityPublishStatus()
    .then(function (status) {
      console.log(tim.name(), 'identity publish status', status)
    })
}

function newCustomerState () {
  return {
    pendingApplications: {},
    forms: {}
  }
}

function newVerificationFor (obj) {
  var verification = {
    document: obj[ROOT_HASH],
    documentOwner: obj.from[ROOT_HASH],
    documentType: obj.parsed.data[TYPE]
  }

  verification[TYPE] = types.VERIFICATION
  return verification
}

// clear(function () {
  // print(init)
// })

// clear(init)
// init()

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

// function init () {
//   setInterval(printIdentityStatus, 30000)
// }

// function onTimReady () {
//   console.log(tim.name(), 'is ready')
// }
