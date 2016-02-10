'use strict'

const typeforce = require('typeforce')
const Q = require('q')
const find = require('array-find')
const constants = require('@tradle/constants')
const MODELS = require('@tradle/models')
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
const MODELS_BY_ID = {}

MODELS.forEach(function (m) {
  MODELS_BY_ID[m.id] = m
})

const PRODUCT_TYPES = MODELS.filter(function (m) {
  return m.subClassOf === 'tradle.FinancialProduct'
}).map(function (m) {
  return m.id
})

const PRODUCT_TO_DOCS = {}
const DOC_TYPES = []
PRODUCT_TYPES.forEach(function (productType) {
  var model = MODELS_BY_ID[productType]
  var docTypes = getForms(model)
  PRODUCT_TO_DOCS[productType] = docTypes
  docTypes.forEach(function (t) {
    if (DOC_TYPES.indexOf(t) === -1) {
      DOC_TYPES.push(t)
    }
  })
})

const noop = function () {}

module.exports = SimpleBank

function SimpleBank (opts) {
  if (!(this instanceof SimpleBank)) {
    return new SimpleBank(opts)
  }

  tradleUtils.bindPrototypeFunctions(this)

  this._employees = opts.employees
  this.tim = opts.tim

  var bank = this.bank = new Bank(opts)
  bank._shouldChainReceivedMessage = function (msg) {
    return msg[TYPE] === types.VERIFICATION ||
      DOC_TYPES.indexOf(msg[TYPE]) !== -1
  }

  bank.use((req, res) => {
    if (DOC_TYPES.indexOf(req.type) !== -1) {
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
      if (PRODUCT_TYPES.indexOf(parsed.type) !== -1) {
        req.productType = parsed.type
        return this.handleNewApplication(req)
      }
    }
    else {
      return bank.send(req, {
        _t: types.SIMPLE_MESSAGE,
        welcome: true,
        // message: '[Hello! It very nice to meet you](Please choose the product)',
        message: 'Switching to representative mode is not yet implemented.',
      }, { chain: false })
      // return bank.send(req, {
      //   _t: types.REQUEST_FOR_REPRESENTATIVE,
      //   welcome: true,
      //   message: 'Switching to representative mode is not yet implemented'
      // }, { chain: false })
    }
  })
  // bank.use(types.REQUEST_FOR_REPRESENTATIVE, function (req) {
  //   // Find represntative
  //   return bank.send(req, {
  //     _t: types.SIMPLE_MESSAGE,
  //     welcome: true,
  //     // message: '[Hello! It very nice to meet you](Please choose the product)',
  //     message: 'The feature of switching to representative is coming soon!',
  //   }, { chain: false })
  // })
}

SimpleBank.prototype.receiveMsg = function (msgBuf, senderInfo) {
  var bank = this.bank
  var msg
  try {
    var wrapper = JSON.parse(msgBuf)
    msg = JSON.parse(new Buffer(wrapper.data, 'base64'))
  } catch (err) {}

  // if it's an identity, store it
  if (!msg) {
    return bank.receiveMsg.apply(bank, arguments)
  }

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

SimpleBank.prototype.sendProductList = function (req) {
  var bank = this.bank
  var formModels = {}
  var productTypes = [
    'tradle.CurrentAccount',
    'tradle.BusinessAccount',
    'tradle.Mortgage',
    'tradle.JumboMortgage'
  ]

  var list = productTypes.map(function (a) {
    var model = MODELS_BY_ID[a]
    var forms = getForms(model)
    forms.forEach(function(f) {
      if (MODELS_BY_ID[f])
        formModels[f] = MODELS_BY_ID[f]
    })
    return model
  })

  for (var p in formModels)
    list.push(formModels[p])

  return bank.send(req, {
    _t: types.PRODUCT_LIST,
    welcome: true,
    // message: '[Hello! It very nice to meet you](Please choose the product)',
    message: '[Hello ' + req.from.identity.name() + '!](Click for a list of products)',
    list: JSON.stringify(list)
  }, { chain: false })
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
        return bank.send(req, resp, { chain: false })
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
    return bank.send(req, resp, { chain: false })
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
  return this.sendNextFormOrApprove(req)
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
  // docState[req[ROOT_HASH]] = {
  //   form: req.parsed.data,
  //   verifications: verifications
  // }

  // pretend we verified it
  var verification = this.newVerificationFor(msg)
  var stored = {
    txId: null,
    body: verification
  }

  docState.verifications.push(stored)
  return bank.send(req, verification)
    .then((entries) => {
      var rootHash = entries[0].toJSON()[ROOT_HASH]
      // stored[ROOT_HASH] = req[ROOT_HASH]
      stored[ROOT_HASH] = rootHash
      return this.sendNextFormOrApprove(req)
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

SimpleBank.prototype.sendNextFormOrApprove = function (req) {
  var bank = this.bank
  var state = req.state
  var pendingApps = state.pendingApplications
  if (!pendingApps.length) {
    return Q()
  }

  var msg = req.msg
  var app = msg.parsed.data
  var productType = req.productType || getRelevantPending(pendingApps, req)
  if (!productType) {
    return utils.rejectWithHttpError(400, 'unable to determine product requested')
  }

  var productModel = MODELS_BY_ID[productType]
  if (!productModel) {
    return utils.rejectWithHttpError(400, 'no such product model: ' + productType)
  }

  // backwards compatible check
  if (!state.products) {
    state.products = {}
  }

  var thisProduct = state.products[productType]
  if (thisProduct) {
    if (thisProduct.length) {
      var resp = utils.buildSimpleMsg(
        'You already have a ' + productModel.title + ' with us!'
      )

      return bank.send(req, resp, opts)
    }
  }
  else {
    thisProduct = state.products[productType] = []
  }

  var isFormOrVerification = req[TYPE] === types.VERIFICATION || DOC_TYPES.indexOf(req[TYPE]) !== -1
  var reqdForms = getForms(productModel)
  var skip
  var missing
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

  var acquiredProduct
  var opts = {}
  var resp
  if (missing) {
    debug('requesting form', missing)
    resp = utils.buildSimpleMsg(
      'Please fill out this form and attach a snapshot of the original document',
      missing
    )

    opts.chain = false
  } else {
    debug('approving for product', productType)
    resp = {}
    resp[TYPE] = productType + 'Confirmation'
    resp.message = 'Congratulations! You were approved for: ' + productModel.title
    resp.forms = reqdForms.map(function(f) {
      var formId = state.forms[f].verifications[0].body.document.id
      var parts = formId.split('_')
      formId = parts.length === 2 ? formId : parts.splice(0, 2).join('_')
      return formId
    })

    acquiredProduct = {}
    acquiredProduct[TYPE] = productType
    thisProduct.push(acquiredProduct)
    var idx = pendingApps.indexOf(productType)
    pendingApps.splice(idx, 1)
  }

  return bank.send(req, resp, opts)
    .then(function (entries) {
      if (acquiredProduct) {
        var entry = entries[0]
        acquiredProduct[ROOT_HASH] = entry.get(ROOT_HASH)
      }

      return entries
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
      return bank.send(req, obj.parsed.data, { chain: false })
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
        return bank.send(req, obj.parsed.data, { chain: false })
      }))
    })
}

SimpleBank.prototype.getEmployee = function (req) {
  var bank = this.bank
  var employeeIdentifier = req.parsed.data.employee
  return this.tim.lookupIdentity(employeeIdentifier)
    .then(employee => {

    })
}

SimpleBank.prototype.handleVerification = function (req) {
  var bank = this.bank
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

  return this.sendNextFormOrApprove(req)
}

SimpleBank.prototype.forgetMe = function (req) {
  var bank = this.bank
  return bank.forgetCustomer(req)
    .then(function () {
      var forgotYou = {}
      forgotYou[TYPE] = FORGOT_YOU
      return bank.send(req, forgotYou)
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

function getForms (model) {
  try {
    return model.forms || model.properties.forms.items
  } catch (err) {
    return []
  }
}

function getRelevantPending (pending, reqState) {
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
