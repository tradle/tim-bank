'use strict'

const util = require('util')
const EventEmitter = require('events').EventEmitter
const typeforce = require('typeforce')
const extend = require('xtend')
const Q = require('q')
const find = require('array-find')
const clone = require('clone')
const constants = require('@tradle/constants')
const BUILTIN_MODELS = require('@tradle/models')
const DEFAULT_PRODUCT_LIST = [
  'tradle.CurrentAccount',
  'tradle.BusinessAccount',
  'tradle.Mortgage',
  'tradle.JumboMortgage'
]

const Builder = require('@tradle/chained-obj').Builder
const tradleUtils = require('@tradle/utils')
const Identity = require('@tradle/identity').Identity
const Bank = require('./')
const utils = require('./lib/utils')
const RequestState = require('./lib/requestState')
const debug = require('./debug')
const ROOT_HASH = constants.ROOT_HASH
const CUR_HASH = constants.CUR_HASH
const TYPE = constants.TYPE
const types = constants.TYPES
const FORGET_ME = 'tradle.ForgetMe'
const FORGOT_YOU = 'tradle.ForgotYou'
const noop = function () {}

function SimpleBank (opts) {
  if (!(this instanceof SimpleBank)) {
    return new SimpleBank(opts)
  }

  tradleUtils.bindPrototypeFunctions(this)
  EventEmitter.call(this)

  this._auto = extend({
    approve: true,
    prompt: true,
    verify: true
  }, opts.auto)

  this._models = utils.processModels(opts.models)
  this._productList = opts.productList || DEFAULT_PRODUCT_LIST
  const missingProduct = find(this._productList, p => !this._models[p])
  if (missingProduct) {
    throw new Error(`missing model for product: ${missingProduct}`)
  }

  this._employees = opts.employees
  this.tim = opts.tim

  var bank = this.bank = new Bank(opts)
  bank._shouldChainReceivedMessage = (msg) => {
    return msg[TYPE] === types.VERIFICATION ||
      this._models.docs.indexOf(msg[TYPE]) !== -1
  }

  bank.use((req, res) => {
    if (this._models.docs.indexOf(req.type) !== -1) {
      return this.handleDocument(req)
    }
  })

  bank.use('tradle.GetMessage', this.lookupAndSend)
  bank.use('tradle.GetHistory', this.sendHistory)
  bank.use('tradle.GetEmployee', this.getEmployee)
  bank.use(FORGET_ME, this.forgetMe)
  bank.use(types.VERIFICATION, this.handleVerification)
  bank.use(types.CUSTOMER_WAITING, this.sendProductList)
  bank.use(types.SIMPLE_MESSAGE, (req) => {
    var msg = req.parsed.data.message
    if (!msg) return

    var parsed = utils.parseSimpleMsg(msg)
    if (parsed.type) {
      if (this._models.products.indexOf(parsed.type) !== -1) {
        req.productType = parsed.type
        return this.handleNewApplication(req)
      }
    }
    else {
      return bank.send({
        req: req,
        msg: {
          _t: types.SIMPLE_MESSAGE,
          welcome: true,
          // message: '[Hello! It very nice to meet you](Please choose the product)',
          message: 'Switching to representative mode is not yet implemented.',
        }
      })
      // return bank.send(req, {
      //   _t: types.REQUEST_FOR_REPRESENTATIVE,
      //   welcome: true,
      //   message: 'Switching to representative mode is not yet implemented'
      // })
    }
  })
  // bank.use(types.REQUEST_FOR_REPRESENTATIVE, function (req) {
  //   // Find represntative
  //   return bank.send(req, {
  //     _t: types.SIMPLE_MESSAGE,
  //     welcome: true,
  //     // message: '[Hello! It very nice to meet you](Please choose the product)',
  //     message: 'The feature of switching to representative is coming soon!',
  //   })
  // })
}

module.exports = SimpleBank
util.inherits(SimpleBank, EventEmitter)

SimpleBank.prototype.receiveMsg = function (msgBuf, senderInfo) {
  var bank = this.bank
  var msg
  try {
    var wrapper = JSON.parse(msgBuf)
    msg = JSON.parse(new Buffer(wrapper.data, 'base64'))
  } catch (err) {}

  if (!msg) {
    return this.receivePrivateMsg(msgBuf, senderInfo)
  }

  // if it's an identity, store it
  if (msg[TYPE] !== types.IDENTITY_PUBLISHING_REQUEST) {
    var errMsg = utils.format('rejecting cleartext {0}, only {1} are accepted in cleartext',
        msg[TYPE],
        types.IDENTITY_PUBLISHING_REQUEST)

    this._debug(errMsg)
    return utils.rejectWithHttpError(400, errMsg)
  }

  if (msg[ROOT_HASH] && senderInfo[ROOT_HASH] && msg[ROOT_HASH] !== senderInfo[ROOT_HASH]) {
    return utils.rejectWithHttpError(401, 'sender doesn\'t match identity embedded in message')
  }

  // fake chainedObj format
  var req = new RequestState({
    from: senderInfo,
    parsed: {
      data: msg
    },
    data: msgBuf
  })

  try {
    req.from.identity = Identity.fromJSON(msg.identity)
  } catch (err) {
    return utils.rejectWithHttpError(400, 'invalid identity')
  }

  return this.publishCustomerIdentity(req)
    .then((_req) => {
      req = _req
      return this.sendProductList(req)
    })
    .then(() => req.end())
}

SimpleBank.prototype.receivePrivateMsg = function (msgBuf, senderInfo) {
  var req = new RequestState({ from: senderInfo })
  return this.tim.lookupIdentity(senderInfo)
    .then(
      (them) => this.bank.receiveMsg(msgBuf, them),
      (err) => this.replyNotFound(req)
    )
}

SimpleBank.prototype.replyNotFound = function (req) {
  return this.bank.send({
    req: req,
    msg: {
      [TYPE]: 'tradle.NotFound',
      resource: req.from
    },
    public: true
  })
  .then(() => {
    return req.end()
  })

  // public=true because not knowing their identity,
  // we don't know how to encrypt messages for them
}

SimpleBank.prototype.sendProductList = function (req) {
  var bank = this.bank
  var formModels = {}
  var list = this._productList.map(productModelId => {
    var model = this._models[productModelId]
    var forms = utils.getForms(model)
    forms.forEach(formModelId => {
      if (this._models[formModelId]) {
        // avoid duplicates by using object
        formModels[formModelId] = this._models[formModelId]
      }
    })

    return model
  })

  for (var p in formModels)
    list.push(formModels[p])

  let name = req.from.identity.name()
  let greeting = name
    ? `Hello ${name}!`
    : 'Hello!'

  return bank.send({
    req: req,
    msg: {
      _t: types.PRODUCT_LIST,
      welcome: true,
      // message: '[Hello! It very nice to meet you](Please choose the product)',
      message: `[${greeting}](Click for a list of products)`,
      list: JSON.stringify(list)
    }
  })
}

SimpleBank.prototype.publishCustomerIdentity = function (req) {
  // TODO: verify that sig of identityPublishRequest comes from sign/update key
  // of attached identity. Need to factor this out of @tradle/verifier
  var self = this
  var bank = this.bank
  var identity = req.parsed.data.identity
  var tim = this.tim
  var rootHash
  var curHash
  var wasAlreadyPublished
  return Builder().data(identity).build()
    .then(function (buf) {
      return Q.ninvoke(tradleUtils, 'getStorageKeyFor', buf)
    })
    .then(function (_curHash) {
      curHash = _curHash.toString('hex')
      rootHash = identity[ROOT_HASH] || curHash
      return Q.all([
        Q.ninvoke(tim.messages(), 'byCurHash', curHash).catch(noop),
        tim.addContactIdentity(identity)
      ])
    })
    .spread(function (obj) {
      // if obj is queued to be chained
      // assume it's on its way to be published
      if (obj && (obj.chain || obj.txId)) {
        // if (obj.dateChained) // actually chained
        // may not be published yet, but def queued
        var resp = utils.buildSimpleMsg('already published', types.IDENTITY)
        return bank.send({
          req: req,
          msg: resp
        })
      } else {
        return publish()
      }
    })
    .then(function () {
      return req
    })

  function publish () {
    if (!Bank.ALLOW_CHAINING) {
      if (process.env.NODE_ENV === 'test') return notifyPublished()

      self._debug('not chaining identity. To enable chaining, set Bank.ALLOW_CHAINING=true', curHash)
      return
    }

    self._debug('sealing customer identity with rootHash: ' + curHash)
    return tim.publishIdentity(identity)
      .then(notifyPublished)
  }

  function notifyPublished () {
    var resp = {}
    resp[TYPE] = 'tradle.IdentityPublished'
    resp.identity = curHash
    return bank.send({
      req: req,
      msg: resp
    })
  }
}

SimpleBank.prototype.handleNewApplication = function (req, res) {
  var bank = this.bank

  typeforce({
    productType: 'String'
  }, req)

  var pending = req.state.pendingApplications
  var idx = pending.indexOf(req.productType)
  if (idx !== -1) pending.splice(idx, 1)

  pending.unshift(req.productType)
  return this.sendNextFormOrApprove({req})
}

SimpleBank.prototype.handleDocument = function (req, res) {
  var bank = this.bank
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
  if (!this._auto.verify) {
    return this.sendNextFormOrApprove({req})
  }

  return this._sendVerification({
    req: req,
    verifiedItem: msg
  })
}

SimpleBank.prototype.sendVerification = function (opts) {
  typeforce({
    verifiedItem: typeforce.oneOf('String', 'Object')
  }, opts)

  const lookup = typeof opts.verifiedItem === 'string'
    ? this.bank.tim.lookupObject(opts.verifiedItem)
    : opts.verifiedItem

  lookup.then(verifiedItem => {
    return this._sendVerification({
      req: new RequestState(verifiedItem),
      verifiedItem: verifiedItem
    })
  })
}

SimpleBank.prototype._sendVerification = function (opts) {
  typeforce({
    req: 'RequestState',
    verifiedItem: 'Object'
  }, opts)

  const req = opts.req
  const doc = opts.verifiedItem
  const verification = this.newVerificationFor(doc)
  const stored = {
    txId: null,
    body: verification
  }

  const docState = req.state.forms[req.type]
  docState.verifications.push(stored)
  return this.bank.send({
      req: req,
      msg: verification,
      chain: true
    })
    .then((entries) => {
      const rootHash = entries[0].toJSON()[ROOT_HASH]
      // stored[ROOT_HASH] = req[ROOT_HASH]
      stored[ROOT_HASH] = rootHash
      return this.sendNextFormOrApprove({req})
    })
}

SimpleBank.prototype.newVerificationFor = function (msg) {
  var bank = this.bank
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

SimpleBank.prototype.sendNextFormOrApprove = function (opts) {
  if (!(this._auto.prompt || this._auto.approve)) return Q()

  typeforce({
    state: '?Object',
    req: '?RequestState',
    productType: '?String'
  }, opts)

  const req = opts.req
  const state = (req || opts).state
  const pendingApps = state.pendingApplications
  if (!pendingApps.length) {
    return Q()
  }

  let productType = opts.productType
  if (req && !productType) {
    productType = req.productType || this._getRelevantPending(pendingApps, req)
  }

  if (!productType) {
    return utils.rejectWithHttpError(400, 'unable to determine product requested')
  }

  const productModel = this._models[productType]
  if (!productModel) {
    return utils.rejectWithHttpError(400, 'no such product model: ' + productType)
  }

  // backwards compatible check
  if (!state.products) {
    state.products = {}
  }

  let thisProduct = state.products[productType]
  if (thisProduct) {
    if (thisProduct.length) {
      const msg = utils.buildSimpleMsg(
        'You already have a ' + productModel.title + ' with us!'
      )

      return this.bank.send({
        msg: msg,
        req: req
      })
    }
  }
  else {
    thisProduct = state.products[productType] = []
  }

  const isFormOrVerification = req[TYPE] === types.VERIFICATION || this._models.docs.indexOf(req[TYPE]) !== -1
  const reqdForms = utils.getForms(productModel)
  let skip
  let missing
  reqdForms.forEach(function (fType) {
    var existing = state.forms[fType]
    if (existing) {
      // have verification, missing form
      // skip, wait to get the form
      // starting with v1.0.7, the bank wants both the form and the verification
      skip = existing.verifications.length && !existing.form

      // missing both form and verification
      if (!existing.form && !existing.verifications.length) {
        missing = missing || fType
      }
    } else {
      missing = missing || fType
    }
  })

  if (isFormOrVerification && skip) return Q()

  if (missing) {
    if (!this._auto.prompt) return Q()

    return this.sendForm({
      req: req,
      form: missing
    })
  }

  const app = {
    productType: productType,
    forms: this._getMyForms(productType, state),
    req: req
  }

  this.emit('application', app)

  if (!this._auto.approve) return Q()

  return this._approveProduct(app)
}

SimpleBank.prototype._getMyForms = function (product, state) {
  const model = typeof product === 'string'
    ? this._models[product]
    : product

  return utils.getForms(model).map(f => {
    let formId = state.forms[f].verifications[0].body.document.id
    let parts = formId.split('_')
    formId = parts.length === 2 ? formId : parts.splice(0, 2).join('_')
    return formId
  })
}

SimpleBank.prototype._simulateReq = function (customerHash) {
  return this.bank._getCustomerState(customerHash)
    .then(state => {
      return new RequestState({
        state: state,
        from: {
          [ROOT_HASH]: customerHash
        }
      })
    })
}

SimpleBank.prototype.approveProduct = function (opts) {
  typeforce({
    customerRootHash: 'String',
    productType: 'String'
  }, opts)

  return this._simulateReq(opts.customerRootHash)
    .then(req => {
      return this._approveProduct({
        req: req,
        productType: opts.productType
      })
    })
}

SimpleBank.prototype._approveProduct = function (opts) {
  // TODO: minimize code repeat with sendNextFormOrApprove
  const req = opts.req
  const state = req.state
  const productType = opts.productType
  const productModel = this._models[productType]
  const forms = this._getMyForms(productType, state)
  const acquiredProduct = {
    [TYPE]: productType
  }

  const thisProduct = state.products[productType]
  thisProduct.push(acquiredProduct)

  debug('approving for product', productType)
  const resp = {
    [TYPE]: productType + 'Confirmation',
    message: 'Congratulations! You were approved for: ' + productModel.title,
    forms: forms
  }

  const pendingApps = state.pendingApplications
  const idx = pendingApps.indexOf(productType)
  pendingApps.splice(idx, 1)

  return this.bank.send({
      req: req,
      msg: resp,
      chain: true
    })
    .then(function (entries) {
      if (acquiredProduct) {
        const entry = entries[0]
        acquiredProduct[ROOT_HASH] = entry.get(ROOT_HASH)
      }

      return entries
    })
}

SimpleBank.prototype.sendForm = function (opts) {
  typeforce({
    form: 'String'
  }, opts)

  const form = opts.form
  const msg = utils.buildSimpleMsg(
    'Please fill out this form and attach a snapshot of the original document',
    form
  )

  debug('requesting form', form)
  return this.bank.send({
    req: opts.req,
    msg: msg
  })
}

SimpleBank.prototype._getRelevantPending = function (pending, reqState) {
  var docType = reqState[TYPE] === types.VERIFICATION
    ? getType(reqState.parsed.data.document)
    : reqState[TYPE]

  return find(pending, productType => {
    if (this._models.docs[productType].indexOf(docType) !== -1) {
      return productType
    }
  })
}

SimpleBank.prototype.lookupAndSend = function (req) {
  var bank = this.bank
  var tim = this.tim
  var info = {}
  var from = req.from[ROOT_HASH]
  var curHash = req.parsed.data.hash

  return Q.ninvoke(tim.messages(), 'byCurHash', curHash, true /* all from/to */)
    .then(function (infos) {
      var match
      var found = infos.some(function (info) {
        // check if they're allowed to see this message
        if ((info.from && info.from[ROOT_HASH] === from) ||
          (info.to && info.to[ROOT_HASH] === from)) {
          match = info
          return true
        }
      })

      if (!match) throw new Error('not found')

      return tim.lookupObject(match)
    })
    .catch(function (err) {
      debug('msg not found', err)
      var httpErr = new Error('not found')
      httpErr.code = 404
      throw httpErr
    })
    .then(function (obj) {
      return bank.send({
        req: req,
        msg: obj.parsed.data
      })
    })
}

SimpleBank.prototype.sendHistory = function (req) {
  var bank = this.bank
  var senderRootHash = req.from[ROOT_HASH]
  var from = {}
  from[ROOT_HASH] = senderRootHash
  return this.tim.history(from)
    .then(function (objs) {
      return Q.all(objs.map(function (obj) {
        return bank.send({
          req: req,
          msg: obj.parsed.data
        })
      }))
    })
}

SimpleBank.prototype.getEmployee = function (req) {
  var bank = this.bank
  var employeeIdentifier = req.parsed.data.employee
  var employeeInfo = find(this._employees, (info) => {
    return info[CUR_HASH] === employeeIdentifier[CUR_HASH]
  })

  if (!employeeInfo) {
    var employeeNotFound = {
      [TYPE]: 'tradle.NotFound',
      identifier: employeeIdentifier
    }

    return this.bank.send({
      req: req,
      msg: employeeNotFound
    })
  }

  var resp = {
    [TYPE]: 'tradle.EmployeeInfo',
    employee: utils.pick(employeeInfo, 'pub', 'profile')
  }

  return this.bank.send({
    req: req,
    msg: resp
  })
}

SimpleBank.prototype.handleVerification = function (req) {
  var msg = req.msg
  var state = req.state
  var verification = msg.parsed.data
  var type = verification.document.id.split('_')[0]
  var docState = state.forms[type] = state.forms[type] || {}

  docState.verifications = docState.verifications || []
  docState.verifications.push({
    rootHash: msg[ROOT_HASH],
    txId: msg.txId,
    body: verification
  })

  return this.sendNextFormOrApprove({req})
}

SimpleBank.prototype.forgetMe = function (req) {
  var bank = this.bank
  return bank.forgetCustomer(req)
    .then(function () {
      var forgotYou = {}
      forgotYou[TYPE] = FORGOT_YOU
      return bank.send({
        req: req,
        msg: forgotYou,
        chain: true
      })
    })
}

SimpleBank.prototype.destroy = function () {
  return this.bank.destroy()
}

SimpleBank.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this.tim.name())
  return debug.apply(null, args)
}

function getType (obj) {
  if (obj[TYPE]) return obj[TYPE]
  if (!obj.id) return
  return obj.id.split('_')[0]
}

function assert (statement, errMsg) {
  if (!statement) {
    throw new Error(errMsg || 'assertion failed')
  }
}
