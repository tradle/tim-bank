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
var utils = require('./utils')
var Q = require('q')
var constants = require('@tradle/constants')
var elistener = require('elistener')
var Tim = require('tim')
var RequestState = require('./requestState')
var EventType = Tim.EventType
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var TYPE = constants.TYPE
// var OWNER = constants.OWNER
var NONCE = constants.NONCE
var types = constants.TYPES
var CUSTOMER = 'tradle.Customer'
// var types = require('./types')

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

  var tim = options.tim
  Object.defineProperty(this, 'tim', {
    value: tim,
    writable: false
  })

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

  this._middles = utils.middles()
}

/**
 * plugin-based msg processing
 * @param  {Function} fn function that can optionally returns a promise
 * @return {Bank}     this instance, for chaining convenience
 */
Bank.prototype.use = function (type, fn) {
  if (typeof type === 'function') {
    fn = type
    type = null
  }

  var handler = fn
  if (type) {
    handler = function (req) {
      if (req.type === type) {
        return fn.apply(this, arguments)
      }
    }
  }

  this._middles.use(handler)
  return this
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

Bank.prototype._setCustomerState = function (req) {
  return this._setResource(CUSTOMER, req.from, req.state)
}

Bank.prototype._saveParsedMsg = function (msg) {
  this._setResource(msg.parsed.data[TYPE], msg[ROOT_HASH], {
    txId: msg.txId,
    body: msg.parsed
  })
}

Bank.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this.tim.name())
  return debug.apply(null, args)
}

Bank.prototype.receiveMsg = function (msgBuf, senderInfo) {
  var self = this
  return this.tim.receiveMsg(msgBuf, senderInfo)
    .then(function (entry) {
      if (entry.get('type') !== EventType.msg.receivedValid) {
        self._debug('invalid message:', entry.get('errors').receive)
        throw new Error('received invalid message:' + msgBuf.toString())
      }

      return self.tim.lookupObject(entry.toJSON())
    })
    .then(function (msg) {
      return self._onMessage(msg)
    })
}

// TODO: lock on sender hash to avoid race conditions
Bank.prototype._onMessage = function (msg) {
  var self = this
  if (!this._ready) {
    return this._readyPromise.then(this._onMessage.bind(this, msg))
  }

  // TODO: move most of this out to implementation (e.g. simple.js)

  var req = new RequestState(msg)
  var res = {}
  var from = req.from
  return this._getCustomerState(from)
    .catch(function (err) {
      if (!err.notFound) throw err

      req.state = newCustomerState(req.from)
      return self._setCustomerState(req)
      // return newCustomerState(req)
    })
    .then(function (state) {
      req.state = state
      return self._middles.exec(req, res)
    })
    .then(function () {
      return self._setCustomerState(req)
    })
    .then(function () {
      // hacky way to make sure sending response
      // is prioritized
      setTimeout(function () {
        self._chainReceivedMsg(msg)
        self._saveParsedMsg(msg)
      }, 100)

      return req.end()
    })
}

Bank.prototype._continue = function (req) {
  return this._sendNextFormOrApprove(req)
}

Bank.prototype._handleDocument = function (req) {
  var self = this
  var type = req.type
  var state = req.state
  var msg = req.msg
  var docState = state.forms[type] = state.forms[type] || {}

  docState.form = {
    body: req.data, // raw buffer
    txId: req.txId
  }

  docState.form[ROOT_HASH] = req[ROOT_HASH]
  docState.verifications = docState.verifications || []
  // docState[req[ROOT_HASH]] = {
  //   form: req.parsed.data,
  //   verifications: verifications
  // }

  // pretend we verified it
  var verification = this._newVerificationFor(msg)
  var stored = {
    txId: null,
    body: verification
  }

  docState.verifications.push(stored)
  return this._send(req, verification)
    .then(function (entries) {
      var rootHash = entries[0].toJSON()[ROOT_HASH]
      // stored[ROOT_HASH] = req[ROOT_HASH]
      stored[ROOT_HASH] = rootHash
      return self._continue(req)
    })
}

Bank.prototype._newVerificationFor = function (msg) {
  var doc = msg.parsed.data
  var verification = {
    document: {
      id: doc[TYPE] + '_' + msg[ROOT_HASH],
      title: doc.title || doc[TYPE]
    },
    documentOwner: {
      id: types.IDENTITY + '_' + msg.from[ROOT_HASH],
      title: msg.from.identity.name()
    }
  }

  // verification.document[TYPE] = doc[TYPE]
  // verification.documentOwner[TYPE] = types.IDENTITY
  var org = this.tim.identityJSON.organization
  if (org) {
    verification.organization = org
  }

  verification[TYPE] = types.VERIFICATION
  return verification
}

Bank.prototype._chainReceivedMsg = function (app) {
  if (!Bank.ALLOW_CHAINING) return Q()

  if (app.chain || app.tx || app.dateUnchained || app[TYPE] === types.VERIFICATION) {
    return Q()
  }

  // chain message on behalf of customer
  return this.tim.chain({
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

Bank.prototype.send = function (req, resp, opts) {
  var self = this
  typeforce('RequestState', req)
  typeforce('Object', resp)

  opts = opts || {}

  if (!('time' in resp)) {
    resp.time = Date.now()
  }

  var maybeSign
  if (!(constants.SIG in resp)) {
    maybeSign = this.tim.sign(resp)
  } else {
    maybeSign = Q(resp)
  }

  return maybeSign
    .then(function (signed) {
      return self.tim.send(extend({
        to: [getSender(req.msg)],
        msg: signed,
        chain: Bank.ALLOW_CHAINING,
        deliver: true
      }, opts))
    })
    .then(function (entries) {
      entries.forEach(function (e) {
        var getSent = utils.waitForEvent(self.tim, 'sent', e)
        req.promise(getSent)
      })

      var rh = entries[0].get(ROOT_HASH)
      self._setResource(resp[TYPE], rh, resp)
      return entries
    })
}

Bank.prototype.destroy = function () {
  if (this._destroyPromise) return this._destroyPromise

  this._destroying = true
  this.stopListening(this.tim)
  this._destroyPromise = Q.all([
    this.tim.destroy(),
    Q.ninvoke(this._db, 'close')
  ])

  return this._destroyPromise
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
          .then(function (msg) {
            console.log('msg', msg[CUR_HASH])
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
