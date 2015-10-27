require('multiplex-utp')

var path = require('path')
var assert = require('assert')
var debug = require('debug')('bank')
var extend = require('xtend')
var levelup = require('levelup')
var map = require('map-stream')
var typeforce = require('typeforce')
var collect = require('stream-collector')
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
var CUSTOMER = 'tradle.Customer'
// var types = require('./lib/types')
var MODELS = require('./lib/models')
var MODELS_BY_ID = {}
MODELS.getModels().forEach(function (m) {
  MODELS_BY_ID[m.id] = m
})

var APP_TYPES = [
  'tradle.CurrentAccount',
  'tradle.HomeInsurance'
]

var DOC_TYPES = APP_TYPES.map(function (a) {
  var model = MODELS_BY_ID[a]
  try {
    return model.forms || model.properties.forms.items
  } catch (err) {
    return []
  }
}).reduce(function (memo, next) {
  return memo.concat(next)
}, [])

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

  ;['chained', 'unchained'].forEach(function (e) {
    tim.on(e, function (info) {
      if (info[TYPE] === types.IDENTITY) return

      tim.lookupObject(info)
        .done(self._updateChained)
    })
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

Bank.prototype.list = function (type) {
  var start = prefixKey(type, '')
  var stream = this._db.createReadStream({
      start: start,
      end: start + '\xff'
    })
    .pipe(map(function (data, cb) {
      cb(null, {
        key: unprefixKey(type, data.key),
        value: data.value
      })
    }))

  return Q.nfcall(collect, stream)
}

Bank.prototype.customers = function () {
  return this.list(CUSTOMER)
}

Bank.prototype.verifications = function () {
  return this.list(types.VERIFICATION)
}

Bank.prototype._getCustomerState = function (customerRootHash) {
  return this._getResource(CUSTOMER, customerRootHash)
}

Bank.prototype._setCustomerState = function (customerRootHash, state) {
  return this._setResource(CUSTOMER, customerRootHash, state)
}

Bank.prototype._updateChained = function (obj) {
  this._setResource(obj.parsed.data[TYPE], obj[ROOT_HASH], {
    txId: obj.txId,
    body: obj.parsed
  })
}

// very inefficient for now
// Bank.prototype._updateChained = function (obj) {
//   var rootHash = obj[ROOT_HASH]
//   var objHash = obj[ROOT_HASH]
//   var txId = obj.txId
//   this.customers()
//     .done(function (customers) {
//       customers.forEach(function (c) {
//         for (var type in c.forms) {
//           var docState = c.forms[type]
//           if (docState.form[ROOT_HASH] === objHash) {
//             docState.form.txId = txId
//           }

//           var verifications = docState.verifications
//           verifications.forEach(function (v) {
//             if (v[ROOT_HASH] === objHash) {
//               v.txId = txId
//             }
//           })
//         }
//       })
//     })
// }

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
  var customerHash = obj.from[ROOT_HASH]
  this._getCustomerState(customerHash)
    .catch(function (err) {
      if (!err.notFound) throw err

      return newCustomerState(obj.from[ROOT_HASH])
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
      var msg = obj.parsed.data.message
      var parsed = utils.parseSimpleMsg(msg)
      if (APP_TYPES.indexOf(parsed.type) !== -1) {
        return this._handleNewApplication(obj, state, parsed.type)
      } else {
        return this._debug('ignoring simple message: ', msg)
      }
    case 'tradle.Verification':
      return this._handleVerification(obj, state)
    // case types.CurrentAccountApplication:
    //   return this._handleCurrentAccountApplication(obj)
    // case types.SharedKYC:
    //   return this._handleSharedKYC(obj)
    default:
      if (DOC_TYPES.indexOf(msgType) !== -1) {
        return this._handleDocument(obj, state)
      } else {
        return this._debug('ignoring message of type', msgType)
      }
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

  docState.form = {
    body: obj.parsed.data,
    txId: obj.txId
  }

  docState.form[ROOT_HASH] = obj[ROOT_HASH]
  docState.verifications = docState.verifications || []
  // docState[obj[ROOT_HASH]] = {
  //   form: obj.parsed.data,
  //   verifications: verifications
  // }

  // pretend we verified it
  var verification = newVerificationFor(obj)
  var stored = {
    txId: null,
    body: verification
  }

  docState.verifications.push(stored)
  return this._respond(obj, verification)
    .then(function (entries) {
      var rootHash = entries[0].toJSON()[ROOT_HASH]
      stored[ROOT_HASH] = obj[ROOT_HASH]
      return self._continue(obj, state)
    })
}

Bank.prototype._handleVerification = function (obj, state) {
  var verification = obj.parsed.data
  var type = verification.document.id.split('_')[0]
  var docState = state.forms[type] = state.forms[type] || {}
  // var formHash = verification.document
  // var formState = docState[formHash] = docState[formHash] || {
  //   form: null,
  //   verifications: []
  // }

  docState.verifications = docState.verifications || []
  docState.verifications.push({
    rootHash: obj[ROOT_HASH],
    txId: obj.txId,
    body: verification
  })

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
    resp.message = 'Congratulations! You were approved for: ' + MODELS_BY_ID[productType].title
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

Bank.prototype._setResource = function (type, rootHash, val) {
  typeforce('String', type)
  typeforce('String', rootHash)
  assert(val !== null, 'missing value')
  return Q.ninvoke(this._db, 'put', prefixKey(type, rootHash), val)
}

Bank.prototype._getResource = function (type, rootHash) {
  typeforce('String', type)
  typeforce('String', rootHash)
  return Q.ninvoke(this._db, 'get', prefixKey(type, rootHash))
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

function unprefixKey(type, key) {
  return key.slice(type.length + 1)
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

function newCustomerState (customerRootHash) {
  var state = {
    pendingApplications: {},
    forms: {}
  }

  state[ROOT_HASH] = customerRootHash
  return state
}

function newVerificationFor (obj) {
  var doc = obj.parsed.data
  var verification = {
    document: {
      id: doc[TYPE] + '_' + obj[ROOT_HASH],
      title: doc.title || doc[TYPE]
    },
    documentOwner: {
      id: types.IDENTITY + '_' + obj.from[ROOT_HASH],
      title: obj.from.identity.name()
    }
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
