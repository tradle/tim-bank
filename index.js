require('@tradle/multiplex-utp')

var assert = require('assert')
var debug = require('debug')('bank')
var extend = require('xtend')
var levelup = require('levelup')
var map = require('map-stream')
var typeforce = require('typeforce')
var collect = require('stream-collector')
var tutils = require('@tradle/utils')
var Builder = require('@tradle/chained-obj').Builder
var utils = require('./lib/utils')
var Q = require('q')
var constants = require('@tradle/constants')
var elistener = require('elistener')
var Tim = require('tim')
var EventType = Tim.EventType
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var TYPE = constants.TYPE
// var OWNER = constants.OWNER
var NONCE = constants.NONCE
var types = constants.TYPES
var CUSTOMER = 'tradle.Customer'
// var types = require('./lib/types')
var MODELS = require('@tradle/models')
var MODELS_BY_ID = {}
MODELS.forEach(function (m) {
  MODELS_BY_ID[m.id] = m
})

var PRODUCT_TYPES = MODELS.filter(function (m) {
  return m.subClassOf === 'tradle.FinancialProduct'
}).map(function (m) {
  return m.id
})

var PRODUCT_TO_DOCS = {}
var DOC_TYPES = []
PRODUCT_TYPES.forEach(function (productType) {
  var model = MODELS_BY_ID[productType]
  var docTypes = getForms(model)
  PRODUCT_TO_DOCS[productType] = docTypes
  DOC_TYPES.push.apply(DOC_TYPES, docTypes)
})

module.exports = Bank
elistener(Bank.prototype)
Bank.ALLOW_CHAINING = true

function Bank (options) {
  var self = this

  typeforce({
    tim: 'Object',
    path: 'String',
    leveldown: 'Function',
    manual: '?Boolean'
  }, options)

  tutils.bindPrototypeFunctions(this)

  var tim = this._tim = options.tim
  this.wallet = tim.wallet

  this.listenTo(tim, 'error', function (err) {
    self._debug('error', err)
  })

  if (!options.manual) {
    this.listenTo(tim, 'message', function (info) {
      tim.lookupObject(info)
        .catch(function (err) {
          self._debug('unable to retrieve object', info)
          if (!self._destroying) throw err
        })
        .then(self._onMessage)
        .done()
    })
  }

  ;['chained', 'unchained'].forEach(function (e) {
    self.listenTo(tim, e, function (info) {
      if (info[TYPE] === types.IDENTITY) return

      tim.lookupObject(info)
        .catch(function (err) {
          self._debug('unable to retrieve object', info)
          if (!self._destroying) throw err
        })
        .then(self._updateChained)
        .done()
    })
  })

  var readyDefer = Q.defer()
  this._readyPromise = readyDefer.promise

  this.listenOnce(tim, 'ready', function () {
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

Bank.prototype._setCustomerState = function (reqState) {
  return this._setResource(CUSTOMER, reqState.from, reqState.state)
}

Bank.prototype._saveParsedReq = function (req) {
  this._setResource(req.parsed.data[TYPE], req[ROOT_HASH], {
    txId: req.txId,
    body: req.parsed
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

Bank.prototype.receiveMsg = function (msgBuf, senderInfo) {
  var self = this
  return this._tim.receiveMsg(msgBuf, senderInfo)
    .then(function (entry) {
      if (entry.get('type') !== EventType.msg.receivedValid) {
        self._debug('invalid message:', entry.get('errors').receive)
        throw new Error('received invalid message:' + msgBuf.toString())
      }

      return self._tim.lookupObject(entry.toJSON())
    })
    .then(function (req) {
      return self._onMessage(req)
    })
}

// TODO: lock on sender hash to avoid race conditions
Bank.prototype._onMessage = function (req) {
  var self = this
  if (!this._ready) {
    return this._readyPromise.then(this._onMessage.bind(this, req))
  }

  var reqState = new RequestState(req)
  var from = reqState.from
  return this._getCustomerState(from)
    .catch(function (err) {
      if (!err.notFound) throw err

      reqState.state = newCustomerState(reqState.from)
      return self._setCustomerState(reqState)
      // return newCustomerState(reqState)
    })
    .then(function (state) {
      reqState.state = state
      return self._onMessageFromCustomer(reqState)
    })
    .then(function () {
      return self._setCustomerState(reqState)
    })
    .then(function () {
      // hacky way to make sure sending response
      // is prioritized
      setTimeout(function () {
        self._chainReceivedMsg(req)
        self._saveParsedReq(req)
      }, 100)

      return reqState.end()
    })
}

Bank.prototype._onMessageFromCustomer = function (reqState) {
  var msgType = reqState.type
  this._debug('received message of type', msgType)

  switch (msgType) {
    case types.GET_MESSAGE:
      return this._lookupAndSend(reqState)
    case types.GET_HISTORY:
      return this._sendHistory(reqState)
    case types.SIMPLE_MESSAGE:
      var msg = reqState.parsed.data.message
      if (msg) {
        var parsed = utils.parseSimpleMsg(msg)
        if (PRODUCT_TYPES.indexOf(parsed.type) !== -1) {
          reqState.productType = parsed.type
          return this._handleNewApplication(reqState)
        }
      }

      // return this.echo(req)
      return this._debug('ignoring simple message: ', msg)
    case 'tradle.Verification':
      return this._handleVerification(reqState)
    // case types.CurrentAccountApplication:
    //   return this._handleCurrentAccountApplication(req)
    // case types.SharedKYC:
    //   return this._handleSharedKYC(req)
    default:
      if (DOC_TYPES.indexOf(msgType) !== -1) {
        return this._handleDocument(reqState)
      } else {
        return this._debug('ignoring message of type', msgType)
      }
  }
}

Bank.prototype._lookupAndSend = function (reqState) {
  var self = this
  var info = {}
  info[CUR_HASH] = reqState.parsed.data.hash
  return this._tim.lookupObject(info)
    .then(function (obj) {
      return self._send(reqState, obj.parsed.data, { chain: false })
    })
}

Bank.prototype._sendHistory = function (reqState) {
  var self = this
  var senderRootHash = reqState.from
  var from = {}
  from[ROOT_HASH] = senderRootHash
  return this._tim.history(from)
    .then(function (objs) {
      return Q.all(objs.map(function (obj) {
        return self._send(reqState, obj.parsed.data, { chain: false })
      }))
    })
}

// Bank.prototype.echo = function (reqState) {
//   this._debug('echoing back', req[TYPE])
//   return this._send(reqState, req.parsed.data)
// }

Bank.prototype._continue = function (reqState) {
  return this._sendNextFormOrApprove(reqState)
}

// Bank.prototype._saveChainedreq = function (req) {
//   var rh = req[ROOT_HASH]
//   var data = req.parsed.data
//   this._setResource(data[TYPE], rh, data)
// }

Bank.prototype._handleDocument = function (reqState) {
  var self = this
  var type = reqState.type
  var state = reqState.state
  var req = reqState.req
  var docState = state.forms[type] = state.forms[type] || {}

  docState.form = {
    body: reqState.data, // raw buffer
    txId: reqState.txId
  }

  docState.form[ROOT_HASH] = reqState[ROOT_HASH]
  docState.verifications = docState.verifications || []
  // docState[req[ROOT_HASH]] = {
  //   form: req.parsed.data,
  //   verifications: verifications
  // }

  // pretend we verified it
  var verification = this._newVerificationFor(req)
  var stored = {
    txId: null,
    body: verification
  }

  docState.verifications.push(stored)
  return this._send(reqState, verification)
    .then(function (entries) {
      var rootHash = entries[0].toJSON()[ROOT_HASH]
      // stored[ROOT_HASH] = req[ROOT_HASH]
      stored[ROOT_HASH] = rootHash
      return self._continue(reqState)
    })
}

Bank.prototype._newVerificationFor = function (req) {
  var doc = req.parsed.data
  var verification = {
    document: {
      id: doc[TYPE] + '_' + req[ROOT_HASH],
      title: doc.title || doc[TYPE]
    },
    documentOwner: {
      id: types.IDENTITY + '_' + req.from[ROOT_HASH],
      title: req.from.identity.name()
    }
  }

  // verification.document[TYPE] = doc[TYPE]
  // verification.documentOwner[TYPE] = types.IDENTITY
  var org = this._tim.identityJSON.organization
  if (org) {
    verification.organization = org
  }

  verification[TYPE] = types.VERIFICATION
  return verification
}

Bank.prototype._handleVerification = function (reqState) {
  var req = reqState.req
  var state = reqState.state
  var verification = req.parsed.data
  var type = verification.document.id.split('_')[0]
  var docState = state.forms[type] = state.forms[type] || {}

  docState.verifications = docState.verifications || []
  docState.verifications.push({
    rootHash: req[ROOT_HASH],
    txId: req.txId,
    body: verification
  })

  return this._continue(reqState)
}

Bank.prototype._sendNextFormOrApprove = function (reqState) {
  var state = reqState.state
  var pendingApps = state.pendingApplications
  if (!pendingApps.length) {
    return Q()
  }

  var req = reqState.req
  var app = req.parsed.data
  var productType = reqState.productType || getRelevantPending(pendingApps, reqState)
  if (!productType) {
    return Q.reject(new Error('unable to determine product requested'))
  }

  var productModel = MODELS_BY_ID[productType]
  if (!productModel) {
    return Q.reject(new Error('no such product model: ' + productType))
  }

  var reqdForms = getForms(productModel)
  var missing = reqdForms.filter(function (fType) {
    var existing = state.forms[fType]
    if (existing) {
      return !existing.verifications.length
    }

    return true
  })

  var opts = {}
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
    var idx = pendingApps.indexOf(productType)
    pendingApps.splice(idx, 1)
  }

  return this._send(reqState, resp, opts)
}

Bank.prototype._handleNewApplication = function (reqState) {
  typeforce({
    productType: 'String'
  }, reqState)

  var pending = reqState.state.pendingApplications
  var idx = pending.indexOf(reqState.productType)
  if (idx !== -1) pending.splice(idx, 1)

  pending.unshift(reqState.productType)
  return this._sendNextFormOrApprove(reqState)
}

Bank.prototype._chainReceivedMsg = function (app) {
  if (!Bank.ALLOW_CHAINING) return Q()

  if (app.chain || app.tx || app.dateUnchained || app[TYPE] === types.VERIFICATION) {
    return Q()
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
    .then(function () {
      return val // convenience for next link in the promise chain
    })
}

Bank.prototype._getResource = function (type, rootHash) {
  typeforce('String', type)
  typeforce('String', rootHash)
  return Q.ninvoke(this._db, 'get', prefixKey(type, rootHash))
}

Bank.prototype._send = function (reqState, resp, opts) {
  var self = this
  typeforce('RequestState', reqState)
  typeforce('Object', resp)

  opts = opts || {}

  if (!('time' in resp)) {
    resp.time = Date.now()
  }

  var maybeSign
  if (!(constants.SIG in resp)) {
    maybeSign = this._tim.sign(resp)
  } else {
    maybeSign = Q(resp)
  }

  return maybeSign
    .then(function (signed) {
      return self._tim.send(extend({
        to: [getSender(reqState.req)],
        msg: signed,
        chain: Bank.ALLOW_CHAINING,
        deliver: true
      }, opts))
    })
    .then(function (entries) {
      entries.forEach(function (e) {
        var getSent = self._waitForEvent('sent', e)
        reqState.addPromise(getSent)
      })

      var rh = entries[0].get(ROOT_HASH)
      self._setResource(resp[TYPE], rh, resp)
      return entries
    })
}

Bank.prototype._waitForEvent = function (event, entry) {
  var self = this
  var uid = entry.get('uid')
  debug('waiting for', uid)
  this._tim.on(event, handler)
  var defer = Q.defer()
  return defer.promise

  function handler (metadata) {
    if (metadata.uid === uid) {
      debug('done waiting for', uid)
      self._tim.removeListener(event, handler)
      defer.resolve(metadata)
    }
  }
}

Bank.prototype.destroy = function () {
  if (this._destroyPromise) return this._destroyPromise

  this._destroying = true
  this.stopListening(this._tim)
  this._destroyPromise = Q.all([
    this._tim.destroy(),
    Q.ninvoke(this._db, 'close')
  ])

  return this._destroyPromise
}

function getRelevantPending (pending, reqState) {
  // debugger
  var found
  var docType = reqState[TYPE] === types.VERIFICATION
    ? getType(reqState.parsed.data.document)
    : reqState[TYPE]

  pending.some(function (productType) {
    if (PRODUCT_TO_DOCS[productType].indexOf(docType) !== -1) {
      found = productType
      return true
    }
  })

  return found
}

function getType (obj) {
  if (obj[TYPE]) return obj[TYPE]
  if (!obj.id) return
  return obj.id.split('_')[0]
}

function getForms (model) {
  try {
    return model.forms || model.properties.forms.items
  } catch (err) {
    return []
  }
}

function getSender (msg) {
  var sender = {}
  sender[ROOT_HASH] = msg.from[ROOT_HASH]
  return sender
}

function prefixKey (type, key) {
  return type + '!' + key
}

function unprefixKey (type, key) {
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
          .then(function (req) {
            console.log('msg', req[CUR_HASH])
          })
      })
  })
}

function newCustomerState (customerRootHash) {
  var state = {
    pendingApplications: [],
    forms: {}
  }

  state[ROOT_HASH] = customerRootHash
  return state
}

function RequestState (req) {
  this.app = null
  this.req = req
  this.txId = req.txId
  this.from = req.from[ROOT_HASH]
  this[TYPE] = req[TYPE]
  this.type = req[TYPE]
  this.data = req.data
  this.parsed = req.parsed
  this[ROOT_HASH] = req[ROOT_HASH]
  this[CUR_HASH] = req[CUR_HASH]
  this.state = null
  this.resp = null
  this.promises = []
}

RequestState.prototype.addPromise = function (promise) {
  this.promises.push(promise)
}

RequestState.prototype.end = function () {
  return Q.all(this.promises)
}
