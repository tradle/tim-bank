'use strict'

// require('@tradle/multiplex-utp')

var assert = require('assert')
var extend = require('xtend')
var levelup = require('levelup')
var mutexify = require('mutexify')
var map = require('map-stream')
var find = require('array-find')
var typeforce = require('typeforce')
var collect = require('stream-collector')
// var tutils = require('@tradle/utils')
var utils = require('./lib/utils')
var Q = require('bluebird-q')
var co = Q.async
var tradle = require('@tradle/engine')
var constants = tradle.constants
var tutils = tradle.utils
var elistener = require('elistener')
var once = require('once')
var RequestState = require('./lib/requestState')
var getNewState = require('./lib/reducers')
var Actions = require('./lib/actionCreators')
var debug = require('./debug')
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.ROOT_HASH
var SIG = constants.SIG
var TYPE = constants.TYPE
// var OWNER = constants.OWNER
var NONCE = constants.NONCE
// var types = constants.TYPES
var VERIFICATION = 'tradle.Verification'
var CUSTOMER = 'tradle.Customer'
var CONTEXT = 'context'
var noop = function () {}
var types = require('./lib/types')

module.exports = Bank
elistener(Bank.prototype)
Bank.ALLOW_CHAINING = true

function Bank (options) {
  var self = this

  typeforce({
    node: 'Object',
    path: 'String',
    leveldown: 'Function',
    name: '?String',
    manual: '?Boolean'
  }, options)

  tutils.bindFunctions(this)

  var tim = tutils.promisifyNode(options.node, Q.Promise)
  tim.on('wroteseal', function (info) {
    self._debug(`wrote chain-seal for ${info.object[TYPE]} in tx with id ${info.txId}`)
  })

  Object.defineProperty(this, 'tim', {
    value: tim,
    writable: false
  })

  this._name = options.name || tim.name
  this.listenTo(tim, 'error', function (err) {
    self._debug('error', err)
  })

  if (!options.manual) {
    this.listenTo(tim, 'message', this._onMessage)
  }

  // ;['chained', 'unchained'].forEach(function (e) {
  //   self.listenTo(tim, e, function (info) {
  //     if (info[TYPE] === types.IDENTITY) return

  //     // ignore forgotten customers
  //     return tim.lookupObject(info)
  //       .catch(function (err) {
  //         self._debug('unable to retrieve object', err)
  //         throw err
  //       })
  //       .then(self._updateChained)
  //   })
  // })

  var readyDefer = Q.defer()
  this._readyPromise = readyDefer.promise.then(() => this._ready = true)
  this._locks = {}
  this._manualReleases = {}

  // don't have any pre-tasks at the moment
  readyDefer.resolve()
  // this.listenOnce(tim, 'ready', function () {
  //   self._ready = true
  //   readyDefer.resolve()
  //   // printIdentityStatus(tim)
  //   //   .then(dumpDBs.bind(null, tim))
  // })

  this._db = levelup(options.path, {
    db: options.leveldown,
    valueEncoding: 'json'
  })

  this._middles = utils.middles()
}

Bank.prototype.lock = function (id, reason="") {
  const self = this
  if (!this._locks[id]) {
    this._locks[id] = mutexify()
  }

  const lock = this._locks[id]
  this._debug(`locking ${id}: ${reason}`)
  return new Promise(function (resolve, reject) {
    lock(function (_release) {
      self._debug(`locked ${id}: ${reason}`)
      const release = once(function () {
        clearTimeout(timeout)
        self._debug(`unlocked ${id}: ${reason}`)
        _release.apply(this, arguments)
      })

      resolve(release)
      const timeout = setTimeout(release, 10000)
    })
  })
}

// Bank.prototype._lock = function (customerHash, reason) {
//   const self = this
//   this._debug(`locking ${customerHash}: ${reason}`)
//   const lock = this._locks[customerHash] = this._locks[customerHash] || mutexify()
//   const defer = Q.defer()
//   let release
//   let released

//   lock(_release => {
//     this._debug(`locked ${customerHash}: ${reason}`)
//     release = () => {
//       clearTimeout(timeout)
//       if (!released) {
//         released = true
//         _release()
//       }
//     }

//     var timeout = setTimeout(release, 10000)
//     self._manualReleases[customerHash] = release
//     defer.resolve()
//   })

//   return defer.promise
// }

// Bank.prototype._unlock = function (customerHash) {
//   const release = this._manualReleases[customerHash]
//   if (release) {
//     this._debug(`unlocking ${customerHash}`)
//     delete this._manualReleases[customerHash]
//     release()
//   }
// }

/**
 * plugin-based msg processing
 * @param  {Function} fn function that can optionally returns a promise
 * @return {Bank}     this instance, for chaining convenience
 */
Bank.prototype.use = function (type, fn) {
  if (typeof type === 'function') {
    fn = type
    type = '*'
  }

  if (!type) throw new Error('invalid type')

  var handler = fn
  if (type !== '*') {
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

Bank.prototype._getCustomerForContext = function (context) {
  return this._getResource(CONTEXT, context)
}

Bank.prototype._setCustomerState = function (req) {
  const promises = []
  if (req.state == null) {
    promises.push(this._delResource(CUSTOMER, req.customer))
    if (req.context) promises.push(this._delResource(CONTEXT, req.context))
  } else {
    promises.push(this._setResource(CUSTOMER, req.customer, req.state))
    if (req.context) promises.push(this._setResource(CONTEXT, req.context, req.customer))
  }

  return Q.all(promises).spread(customerState => customerState)
}

/**
 * Delete customer state and customer data from keeper
 * @param  {[type]} req [description]
 * @return {[type]}     [description]
 */
Bank.prototype.forgetCustomer = function (req) {
  var self = this
  var v = req.state.bankVersion
  // clear customer slate
  var info = Actions.newCustomer(req.state)
  req.state = getNewState(null, info)
  req.state.bankVersion = v // preserve version
  return this.tim.forget(req.from.permalink)
}

Bank.prototype._saveParsedMsg = function (req) {
  const objWrapper = req.payload
  return this._setResource(objWrapper.object[TYPE], objWrapper.link, {
    txId: req.txId,
    body: objWrapper.object
  })
}

Bank.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this._name)
  return debug.apply(null, args)
}

Bank.prototype.receiveMsg = co(function* (msg, senderInfo, sync) {
  const received = yield this.tim.receive(msg, senderInfo)
  return this._onMessage(received, sync)
})

Bank.prototype.setEmployees = function (employees) {
  this._employees = employees
}

Bank.prototype._onMessage = co(function* (received, sync) {
  const self = this
  yield this._readyPromise

  const msgWrapper = received.message
  const objWrapper = received.object
  const obj = objWrapper.object
  if (!obj[TYPE]) {
    return utils.rejectWithHttpError(400, 'message missing ' + TYPE)
  }

  const from = msgWrapper.author.permalink
  let customer = from
  const employee = find(this._employees || [], e => {
    return e[ROOT_HASH] === from
  })

  const fwdTo = !Bank.NO_FORWARDING && msgWrapper.object.forward
  if (fwdTo) {
    if (!employee) {
      return utils.rejectWithHttpError(403, 'this bot only forwards message from employees')
    }

    if (fwdTo !== this.tim.permalink && fwdTo !== this.tim.link) {
      if (obj[TYPE] !== VERIFICATION) {
        // re-sign the object
        // the customer doesn't need to know the identity of the employee
        // forward without processing
        const context = msgWrapper.object.context
        const other = context && { context }
        this.tim.signAndSend({
          to: { permalink: fwdTo },
          object: tutils.omit(obj, SIG),
          other: other
        })

        return
      }

      // set actual customer
      customer = fwdTo
    }
  }

  // TODO: move most of this out to implementation (e.g. simple.js)
  let appLink = msgWrapper.object.context
  // HACK!
  if (!appLink && obj[TYPE] === 'tradle.ShareContext') {
    appLink = utils.parseObjectId(obj.context.id).permalink
  }

  const req = new RequestState(msgWrapper, objWrapper)
  req.sync = sync
  req.customer = customer

  if (appLink) {
    try {
      customer = req.customer = yield this._getCustomerForContext(appLink)
      req.customerIdentityInfo = yield this.tim.addressBook.lookupIdentity({ permalink: customer })
    } catch (err) {
      this._debug('customer not found for context', appLink, err)
    }
  }

  const unlock = yield this.lock(customer, 'process incoming message')
  try {
    return yield this._handleRequest(req)
  } finally {
    unlock()
  }
})

Bank.prototype._handleRequest = co(function* (req) {
  const self = this
  const customer = req.customer
  const from = req.from
  const type = req.type

  var res = {}
  this._debug(`received ${type} from ${from}`)
  let state
  try {
    state = yield this._getCustomerState(customer)
  } catch (err) {
    if (!err.notFound) throw err

    const cInfo = {
      permalink: customer,
      identity: from.object
    }

    if (type === 'tradle.IdentityPublishRequest' || type === 'tradle.SelfIntroduction') {
      const profile = req.payload.object.profile
      if (profile) cInfo.profile = cInfo
    }

    state = getNewState(null, Actions.newCustomer(cInfo))

    yield self._setCustomerState(req)
  }

  req.state = state

  try {
    yield self._middles.exec(req, res)
    yield self._setCustomerState(req)
    if (self.shouldChainReceivedMessage(req)) {
      self._debug('queuing chain-seal for received msg', req[TYPE])
      // don't wait for this
      self._chainReceivedMessage(req)
        .catch(function (err) {
          debug('failed to chain received msg', err)
        })
    }

    yield self._saveParsedMsg(req)
  } catch (err) {
    this._debug('experienced error while processing request', err)
    throw err
  } finally {
    yield req.end()
  }

  return req
})

// Bank.prototype.createOrUpdateCustomer = function (customer) {
//   if (typeof customer === 'string') {
//     customer = { permalink: customer }
//   }

//   let getNewState
//   const clink = customer.permalink
//   return this.lock(clink, 'update or create customer')
//     .then(() => this._getCustomerState(clink))
//     .then(state => {
//       return getNewState(state, Actions.updateCustomer(customer))
//     }, err => {
//       if (!err.notFound) throw err

//       return getNewState(null, Actions.newCustomer(customer))
//     })
//     .then(state => {
//       newState = state
//       this._setCustomerState({ customer: clink, state })
//     })
//     .finally(this._unlock(clink))
//     .then(() => newState)
// }

Bank.prototype.shouldChainReceivedMessage = function (req) {
  // override this method
  if (!Bank.ALLOW_CHAINING) return false

  if (req.nochain || req.chain || req.tx || req.dateUnchained) {
    return false
  }

  return this._shouldChainReceivedMessage(req)
}

Bank.prototype._shouldChainReceivedMessage = function (req) {
  return false
}

Bank.prototype._chainReceivedMessage = function (req) {
  // chain message on behalf of customer
  return this.tim.seal({ link: req.payload.link })
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
    // .then(r => tutils.rebuf(r))
}

Bank.prototype._delResource = function (type, rootHash) {
  typeforce('String', type)
  typeforce('String', rootHash)
  return Q.ninvoke(this._db, 'del', prefixKey(type, rootHash))
};

Bank.prototype.createReadStream = function (type, opts={}) {
  return this._db.createReadStream(extend({
    gt: prefixKey(type, ''),
    lt: prefixKey(type, '\xff')
  }, opts))
}

Bank.prototype.createCustomerStream = function (opts) {
  return this.createReadStream(CUSTOMER, opts)
}

/**
 * Send message to customer
 * @param  {Object} opts
 * @param  {?RequestState} opts.req
 * @return {Promise}
 */
Bank.prototype.send = co(function* (opts) {
  // typeforce('RequestState', req)
  // typeforce('Object', resp)

  const req = opts.req
  const msg = opts.msg
  if (!('time' in msg)) {
    msg.time = Date.now()
  }

  const recipient = req.from
  this._debug(`sending ${msg[TYPE]} to ${recipient.permalink}`)

  let signed
  if (constants.SIG in msg) {
    signed = { object: msg }
  } else {
    signed = yield this.tim.sign({ object: msg })
  }

  const context = req.context
  const result = yield this.tim.send({
    to: recipient,
    object: signed.object,
    other: context && { context }
  })

  if (req && req.sync) {
    var getSent = utils.waitForEvent(this.tim, 'sent', result.message.link)
    req.promise(getSent)
  }

  yield this._setResource(msg[TYPE], result.object.permalink, result.object.object)
  return result
})

Bank.prototype.destroy = function () {
  if (this._destroyPromise) return this._destroyPromise

  this._destroying = true
  this.stopListening(this.tim)
  this._destroyPromise = Q.all([
    // this.tim.destroy(),
    Q.ninvoke(this._db, 'close')
  ])

  for (var customer in this._manualReleases) {
    this._manualReleases[customer]()
  }

  return this._destroyPromise
}

function getSender (msg) {
  if (!msg) debugger
  return {
    permalink: msg.author.permalink
  }
}

function prefixKey (type, key) {
  return type + '!' + key
}

function unprefixKey (type, key) {
  return key.slice(type.length + 1)
}

// function dumpDBs (tim) {
//   var identities = tim.identities()
//   identities.onLive(function () {
//     identities.createValueStream()
//       .on('data', function (result) {
//         // console.log('identity', result.identity.name.firstName)
//         console.log('identity', result.identity)
//       })
//   })

//   var messages = tim.messages()
//   messages.onLive(function () {
//     messages.createValueStream()
//       .on('data', function (data) {
//         tim.lookupObject(data)
//           .then(function (msg) {
//             console.log('msg', msg[CUR_HASH])
//           })
//       })
//   })
// }
