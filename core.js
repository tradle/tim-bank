// require('@tradle/multiplex-utp')

const assert = require('assert')
const extend = require('xtend')
const levelup = require('levelup')
const mutexify = require('mutexify')
const through = require('through2')
const pump = require('pump')
const find = require('array-find')
const typeforce = require('typeforce')
const collect = require('stream-collector')
// const tutils = require('@tradle/utils')
const utils = require('./lib/utils')
const Q = require('bluebird-q')
const co = Q.async
const tradle = require('@tradle/engine')
const constants = tradle.constants
const tutils = tradle.utils
const elistener = require('elistener')
const once = require('once')
const RequestState = require('./lib/requestState')
const debug = require('./debug')
const CUR_HASH = constants.CUR_HASH
const ROOT_HASH = constants.ROOT_HASH
const SIG = constants.SIG
const TYPE = constants.TYPE
// const OWNER = constants.OWNER
const NONCE = constants.NONCE
// const types = constants.TYPES
const VERIFICATION = 'tradle.Verification'
const CUSTOMER = 'tradle.Customer'
const CONTEXT = 'context'
const noop = function () {}
const types = require('./lib/types')

module.exports = Bank
elistener(Bank.prototype)
Bank.ALLOW_CHAINING = true

function Bank (options) {
  const self = this

  typeforce({
    node: 'Object',
    path: 'String',
    leveldown: 'Function',
    name: '?String',
    manual: '?Boolean'
  }, options)

  tutils.bindFunctions(this)

  const tim = tutils.promisifyNode(options.node, Q.Promise)
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

  const readyDefer = Q.defer()
  this._readyPromise = readyDefer.promise.then(() => this._ready = true)
  this._locks = {}

  // don't have any pre-tasks at the moment
  readyDefer.resolve()
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

  let handler = fn
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

Bank.prototype.listContexts = function (opts) {
  return this.list(CONTEXT, opts)
}

Bank.prototype.listCustomers = function (opts) {
  return this.list(CUSTOMER, opts)
}

Bank.prototype.list = function (type, opts={}) {
  const start = prefixKey(type, '')
  opts = extend({
    start: start,
    end: start + '\xff'
  }, opts)

  const stream = pump(
    this._db.createReadStream(opts),
    through.obj(function (data, enc, cb) {
      cb(null, {
        key: unprefixKey(type, data.key),
        value: data.value
      })
    })
  )

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

Bank.prototype._saveParsedMsg = function (req) {
  const objWrapper = req.payload
  return this._setResource(objWrapper.object[TYPE], objWrapper.link, {
    txId: req.txId,
    body: objWrapper.object
  })
}

Bank.prototype._debug = function () {
  const args = [].slice.call(arguments)
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

  // TODO: move most of this out to implementation (e.g. simple.js)
  let appLink = msgWrapper.object.context
  // HACK!
  if (!appLink && obj[TYPE] === 'tradle.ShareContext') {
    appLink = utils.parseObjectId(obj.context.id).permalink
  }

  const req = new RequestState(msgWrapper, objWrapper)
  req.sync = sync
  req.customer = customer
  const fwdTo = !Bank.NO_FORWARDING && msgWrapper.object.forward
  if (fwdTo) {
    if (!employee) {
      return utils.rejectWithHttpError(403, 'this bot only forwards message from employees')
    }

    if (fwdTo === this.tim.permalink || fwdTo === this.tim.link) {
      this._debug('not forwarding to self')
      return
    }

    // set actual customer
    req.customer = fwdTo
    req.isFromEmployeeToCustomer = true
  }

  if (appLink) {
    try {
      customer = req.customer = yield this._getCustomerForContext(appLink)
      req.customerIdentityInfo = yield this.tim.addressBook.lookupIdentity({ permalink: customer })
    } catch (err) {
      this._debug('customer not found for context', appLink)
    }
  }

  const unlock = yield this.lock(customer, 'process incoming message')
  try {
    return yield this._handleRequest(req)
  } catch (err) {
    this._debug('Error handling request:', err)
    throw err
  } finally {
    unlock()
  }
})

Bank.prototype._handleRequest = co(function* (req) {
  const self = this
  const customer = req.customer
  const from = req.from
  const type = req.type

  const res = {}
  this._debug(`received ${type} from ${from}`)
  let state
  try {
    state = req.state = yield this._getCustomerState(customer)
  } catch (err) {
    if (!err.notFound) throw err
  }

  try {
    yield self._middles.exec(req, res)
    yield self._setCustomerState(req)
    // if (self.shouldChainReceivedMessage(req)) {
    //   self._debug('queuing chain-seal for received msg', req[TYPE])
    //   // don't wait for this
    //   self._chainReceivedMessage(req)
    //     .catch(function (err) {
    //       debug('failed to chain received msg', err)
    //     })
    // }

    yield self._saveParsedMsg(req)
  } catch (err) {
    this._debug('experienced error while processing request', err)
    throw err
  } finally {
    yield req.end()
  }

  return req
})

// Bank.prototype.shouldChainReceivedMessage = function (req) {
//   // override this method
//   if (!Bank.ALLOW_CHAINING) return false

//   if (req.nochain || req.chain || req.tx || req.dateUnchained) {
//     return false
//   }

//   return this._shouldChainReceivedMessage(req)
// }

// Bank.prototype._shouldChainReceivedMessage = function (req) {
//   return false
// }

// Bank.prototype._chainReceivedMessage = function (req) {
//   // chain message on behalf of customer
//   return this.tim.seal({ link: req.payload.link })
// }

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
  const recipient = req.customer ? { permalink: req.customer } : req.from
  this._debug(`sending ${msg[TYPE]} to ${recipient.permalink}`)

  let signed
  if (constants.SIG in msg) {
    signed = { object: msg }
  } else {
    if (!('time' in msg)) {
      msg.time = Date.now()
    }

    signed = yield this.tim.sign({ object: msg })
  }

  const context = req.context
  const result = yield this.tim.send({
    to: recipient,
    object: signed.object,
    other: context && { context }
  })

  if (req && req.sync) {
    const getSent = utils.waitForEvent(this.tim, 'sent', result.message.link)
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

  for (let customer in this._manualReleases) {
    this._manualReleases[customer]()
  }

  return this._destroyPromise
}

function getSender (msg) {
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
