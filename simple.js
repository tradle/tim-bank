'use strict'

const util = require('util')
const EventEmitter = require('events').EventEmitter
const crypto = require('crypto')
const typeforce = require('typeforce')
const extend = require('xtend')
const mutableExtend = require('xtend/mutable')
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
const SIG = constants.SIG
const SIGNEE = constants.SIGNEE
const TYPE = constants.TYPE
const types = constants.TYPES
const FORGET_ME = 'tradle.ForgetMe'
const FORGOT_YOU = 'tradle.ForgotYou'
const GUEST_SESSION = 'guestsession'
const REMEDIATION = 'tradle.Remediation'
const REMEDIATION_MODEL = {
  [TYPE]: 'tradle.Model',
  id: REMEDIATION,
  subClassOf: 'tradle.FinancialProduct',
  interfaces: ['tradle.Message'],
  forms: []
}

const noop = function () {}

function SimpleBank (opts) {
  if (!(this instanceof SimpleBank)) {
    return new SimpleBank(opts)
  }

  tradleUtils.bindPrototypeFunctions(this)
  EventEmitter.call(this)

  this._auto = extend({
    // approve: true,
    prompt: true,
    verify: true
  }, opts.auto)

  const rawModels = (opts.models || []).concat(REMEDIATION_MODEL)
  this._models = Object.freeze(utils.processModels(rawModels))

  this._productList = (opts.productList || DEFAULT_PRODUCT_LIST).slice()
  this._productList.push(REMEDIATION)

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
  bank.use('tradle.GuestSessionProof', this.importSession)
  bank.use(FORGET_ME, this.forgetMe)
  bank.use(types.VERIFICATION, this.handleVerification)
  bank.use(types.CUSTOMER_WAITING, this.sendProductList)
  bank.use(types.SIMPLE_MESSAGE, (req) => {
    var msg = req.parsed.data.message
    if (!msg) return

    var parsed = utils.parseSimpleMsg(msg)
    if (parsed.type) {
      if (this._productList.indexOf(parsed.type) === -1) {
        return this.replyNotFound(req, parsed.type)
      } else {
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

SimpleBank.prototype.receiveMsg = function (msgBuf, senderInfo, sync) {
  var bank = this.bank
  var msg
  try {
    var wrapper = JSON.parse(msgBuf)
    msg = JSON.parse(new Buffer(wrapper.data, 'base64'))
  } catch (err) {}

  if (!msg) {
    return this.receivePrivateMsg(msgBuf, senderInfo, sync)
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
    sync: sync,
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

  const from = senderInfo[ROOT_HASH] || senderInfo.fingerprint
  return this.bank._lock(from, 'publish identity')
    .then(() => this.publishCustomerIdentity(req))
    .then(() => this.sendProductList(req))
    .finally(() => req.end())
    .finally(() => this.bank._unlock(from))
}

SimpleBank.prototype.receivePrivateMsg = function (msgBuf, senderInfo, sync) {
  return this.tim.lookupIdentity(senderInfo)
    .then(
      (them) => this.bank.receiveMsg(msgBuf, them, sync),
      (err) => {
        const req = new RequestState({ from: senderInfo })
        return this.replyNotFound(req)
      }
    )
}

SimpleBank.prototype.replyNotFound = function (req, whatWasntFound) {
  return this.bank.send({
    req: req,
    msg: {
      [TYPE]: 'tradle.NotFound',
      resource: whatWasntFound || req.from
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
  var list = this._productList
    .filter(productModelId => productModelId !== REMEDIATION)
    .map(productModelId => {
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
  const bank = this.bank
  const type = req.type
  const state = req.state
  const msg = req.msg
  const next = () => {
    const docState = state.forms[type] = state.forms[type] || {}
    const doc = req.parsed ? req.parsed.data : JSON.parse(req.data.toString())

    docState.form = {
      [CUR_HASH]: req[CUR_HASH],
      // body: req.data, // raw buffer
      body: doc,
      txId: req.txId
    }

    docState.verifications = docState.verifications || []
    const prefilledVerification = this._getImportedVerification(state, doc)
    if (!prefilledVerification && !this._auto.verify) {
      return this.sendNextFormOrApprove({req})
    }

    return this._sendVerification({
      req: req,
      verifiedItem: msg
    })
    .then(() => {
      return this.sendNextFormOrApprove({req})
    })
    .then(() => {
      if (state.prefilled) delete state.prefilled[type]
    })
  }

  return this.validateDocument(req)
    .then(
      next,
      errs => {
        req.nochain = true
        return this.requestEdit(req, errs)
      }
    )
}

SimpleBank.prototype.validateDocument = function (req) {
  const doc = req.parsed.data
  const type = doc[TYPE]
  const model = this._models[type]
  if (!model) throw new Error(`unknown type ${type}`)

  const errs = utils.validateResource(doc, model)
  return errs ? Q.reject(errs) : Q()
}

SimpleBank.prototype._sendVerification = function (opts) {
  typeforce({
    req: 'RequestState',
    verifiedItem: 'Object'
  }, opts)

  const req = opts.req
  const doc = opts.verifiedItem
  const verification = this.newVerificationFor(req, doc)
  const stored = {
    txId: null,
    body: verification
  }

  const docState = req.state.forms[doc[TYPE]]
  if (!docState) {
    return utils.rejectWithHttpError(400, new Error('form not found'))
  }

  docState.verifications.push(stored)
//   const prefilled = req.state.prefilled
//   if (prefilled) delete prefilled[doc[TYPE]]

  return this.bank.send({
      req: req,
      msg: verification,
      chain: true
    })
    .then(entries => {
      return this.tim.lookupObject(entries[0].toJSON())
    })
    .then(obj => {
      mutableExtend(stored, obj.parsed.data)
    })
}

SimpleBank.prototype.sendVerification = function (opts) {
  typeforce({
    verifiedItem: typeforce.oneOf('String', 'Object')
  }, opts)

  const lookup = typeof opts.verifiedItem === 'string'
    ? this.bank.tim.lookupObjectByCurHash(opts.verifiedItem)
    : opts.verifiedItem

  let verifiedItem
  let req
  return lookup
    .then(_verifiedItem => {
      verifiedItem = _verifiedItem
      req = new RequestState(verifiedItem)
      return this.bank._lock(verifiedItem.from[ROOT_HASH], 'send verification')
    })
    .then(() => {
      return this.bank._getCustomerState(verifiedItem.from[ROOT_HASH])
    })
    .then(state => {
      req.state = state
      return this._sendVerification({
        req: req,
        verifiedItem: verifiedItem
      })
    })
    .then(() => {
      const prefilled = req.state.prefilled
      if (prefilled) delete prefilled[verifiedItem.parsed.data[TYPE]]

      return this.bank._setCustomerState(req)
    })
    .finally(() => req.end())
    .finally(() => this.bank._unlock(verifiedItem.from[ROOT_HASH]))
}

SimpleBank.prototype._getImportedVerification = function (state, doc) {
  const prefilled = state.prefilled && state.prefilled[doc[TYPE]]
  if (prefilled && prefilled.verification && utils.formsEqual(prefilled.form, doc)) {
    return prefilled.verification
  }
}

SimpleBank.prototype.newVerificationFor = function (req, msg) {
  const bank = this.bank
  const doc = msg.parsed.data
  let verification = this._getImportedVerification(req.state, doc)
  if (!verification) {
    verification = {}
  } else if (verification.time) {
    verification.backDated = verification.time
    delete verification.time
  }

  verification.document = {
    id: doc[TYPE] + '_' + msg[CUR_HASH],
    title: doc.title || doc[TYPE]
  }

  verification.documentOwner = {
    id: types.IDENTITY + '_' + msg.from[ROOT_HASH],
    title: msg.from.identity.name()
  }

  const org = this.tim.identityJSON.organization
  if (org) {
    verification.organization = org
  }

  verification[TYPE] = types.VERIFICATION
  return verification
}

SimpleBank.prototype.requestEdit = function (req, errs) {
  typeforce({
    message: 'String',
    errors: '?Array'
  }, errs)

  const prefill = req.parsed.data
  if (prefill) {
    // clean prefilled data
    for (let p in prefill) {
      if (p[0] === '_' && p !== TYPE) {
        delete prefill[p]
      }
    }
  }

  let message = errs.message
  if (req.productType === REMEDIATION) {
    message = 'Importing...' + message[0].toLowerCase() + message.slice(1)
  }

  return this.bank.send({
    req: req,
    msg: {
      [TYPE]: 'tradle.FormError',
      prefill: prefill,
      message: message,
      errors: errs.errors
    }
  })
}

SimpleBank.prototype.sendNextFormOrApprove = function (opts) {
  if (!(this._auto.prompt || this._auto.verify)) return Q()

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

  const isRemediation = productType === REMEDIATION
  const productModel = isRemediation ? REMEDIATION_MODEL : this._models[productType]
  if (!productModel) {
    return utils.rejectWithHttpError(400, 'no such product model: ' + productType)
  }

  // backwards compatible check
  if (!state.products) {
    state.products = {}
  }

  const thisProduct = state.products[productType]
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
  else if (productType !== REMEDIATION) {
    state.products[productType] = []
  }

  const isFormOrVerification = req[TYPE] === types.VERIFICATION || this._models.docs.indexOf(req[TYPE]) !== -1
  const reqdForms = isRemediation
    ? Object.keys(state.prefilled)
    : utils.getForms(productModel)

  let skip
  let missing
  reqdForms.forEach(function (fType) {
    var existing = state.forms[fType]
    if (existing) {
      // have verification, missing form
      // skip, wait to get the form
      // starting with v1.0.7, the bank doesn't settle for just the verification, it wants the form
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

    const prefilled = state.prefilled[missing]
    if (prefilled) {
      const docReq = new RequestState({
        [TYPE]: missing,
        state: state,
        from: req.from,
        to: req.to,
        productType: productType,
        parsed: {
          data: prefilled.form
        }
      })

      // TODO: figure out how to continue on req
      docReq.promise = req.promise.bind(req)
      docReq.sync = req.sync
      return this.handleDocument(docReq)
    }

    return this.requestForm({
      req: req,
      form: missing
    })
  }

  if (isRemediation) {
    const msg = utils.buildSimpleMsg(
      'Thank you for confirming your information with us!'
    )

    debug('finished remediation')
    return this.bank.send({
      req: req,
      msg: msg
    })
  }

  let forms = utils.getForms(productModel).map(f => {
    const form = state.forms[f].form
    return {
      [CUR_HASH]: form[CUR_HASH] || form[ROOT_HASH],
      body: form.body
      // body: JSON.parse(form.body.toString('binary'))
    }
  })

  this.emit('application', {
    customer: req.from[ROOT_HASH],
    productType: productType,
    forms: forms,
    req: this._auto.verify ? null : req
  })

  if (!this._auto.verify) {
    // 'application' event ugly side-effect
    return req.continue || Q()
  }

  return this._approveProduct({
    productType: productType,
    req: req
  })
}

SimpleBank.prototype._getMyForms = function (product, state) {
  const model = typeof product === 'string'
    ? this._models[product]
    : product

  return utils.getForms(model).map(f => {
    const ret = { [TYPE]: f }
    const docState = state.forms[f]
    const verifications = docState.verifications
    if (verifications && verifications.length) {
      let formId = state.forms[f].verifications[0].body.document.id
      let parts = formId.split('_')
      ret[CUR_HASH] = parts[1]
    } else {
      ret[CUR_HASH] = docState.form[CUR_HASH]
    }

    return ret
  })
}

SimpleBank.prototype._simulateReq = function (customerHash) {
  let req
  return this.bank._getCustomerState(customerHash)
    .then(state => {
      req = new RequestState({
        state: state,
        from: {
          [ROOT_HASH]: customerHash
        }
      })

      return this.bank._lock(customerHash)
    })
    .then(() => req)
}

SimpleBank.prototype.approveProduct = function (opts) {
  typeforce({
    customerRootHash: 'String',
    productType: 'String'
  }, opts)

  let req
  // return this._simulateReq(opts.customerRootHash)
  const customerHash = opts.customerRootHash
  return this.bank._lock(customerHash, 'approve product')
    .then(() => this.bank._getCustomerState(customerHash))
    .then(state => {
      req = new RequestState({
        state: state,
        from: {
          [ROOT_HASH]: customerHash
        }
      })

      return this._approveProduct({
        req: req,
        productType: opts.productType
      })
    })
    .then(() => this.bank._setCustomerState(req))
    .finally(() => req.end())
    .finally(() => this.bank._unlock(opts.customerRootHash))
}

SimpleBank.prototype.models = function () {
  return this._models
}

SimpleBank.prototype.getCustomerState = function (customerHash) {
  return this.bank._getCustomerState(customerHash)
}

SimpleBank.prototype._approveProduct = function (opts) {
  // TODO: minimize code repeat with sendNextFormOrApprove
  const req = opts.req
  const state = req.state
  const productType = opts.productType
  const productModel = this._models[productType]
  const missingForms = utils.getMissingForms(state, productModel)
  if (missingForms.length) {
    return utils.rejectWithHttpError(400, 'request the following forms first: ' + missingForms.join(', '))
  }

  const missingVerifications = utils.getUnverifiedForms(this.tim.myRootHash(), state, productModel)
  if (missingVerifications.length) {
    const types = missingVerifications.map(f => f[TYPE]).join(', ')
    return utils.rejectWithHttpError(400, 'verify the following forms first: ' + types)
  }

  // const promiseVerifications = Q.all(unverified.map(docState => {
  //   return this.sendVerification({
  //     req: req,
  //     verifiedItem: docState.form[ROOT_HASH]
  //   })
  // }))

  let unconfirmedProduct
  // if (state.unconfirmedProducts && state.unconfirmedProducts[productType]) {
  //   unconfirmedProduct = state.unconfirmedProducts[productType].shift()
  // }

  const acquiredProduct = unconfirmedProduct || {
    [TYPE]: productType
  }

  const thisProduct = state.products[productType]
  thisProduct.push(acquiredProduct)

  debug('approving for product', productType)

  const confirmation = this._newProductConfirmation(req, productType, !!unconfirmedProduct)
  const pendingApps = state.pendingApplications
  const idx = pendingApps.indexOf(productType)
  pendingApps.splice(idx, 1)

  // return promiseVerifications
  //   .then(() => {
      return this.bank.send({
        req: req,
        msg: confirmation,
        chain: true
      })
    // })
    .then(function (entries) {
      if (acquiredProduct) {
        const entry = entries[0]
        acquiredProduct[ROOT_HASH] = entry.get(ROOT_HASH)
      }

      return entries
    })
}

SimpleBank.prototype._newProductConfirmation = function (req, productType, imported) {
  const productModel = this._models[productType]
  const state = req.state
  const forms = state.forms
  const customerHash = req.from[ROOT_HASH]

  /**
   * Heuristic:
   * Copy all properties from forms to confirmation object
   * where the property with the same name exists in both
   * the form and confirmation model
   * @param  {Object} confirmation
   * @return {Object} confirmation
   */
  const copyProperties = (confirmation, confirmationType) => {
    const confirmationModel = this._models[confirmationType]
    const props = confirmationModel.properties
    for (let id in forms) {
      const form = forms[id].form.body
      for (let pName in form) {
        if (pName.charAt[0] === '_') continue
        if (pName in props) {
          confirmation[pName] = form[pName]
        }
      }
    }

    return confirmation
  }

  let confirmation = {}
  let confirmationType
  switch (productType) {
    case 'tradle.LifeInsurance':
      confirmationType = 'tradle.MyLifeInsurance'
      copyProperties(confirmation, confirmationType)
      mutableExtend(confirmation, {
        [TYPE]: confirmationType,
        policyNumber: utils.randomDecimalString(10), // 10 chars long
      })

      return confirmation
    case 'tradle.Mortgage':
    case 'tradle.MortgageProduct':
      confirmationType = 'tradle.MyMortgage'
      copyProperties(confirmation, confirmationType)
      mutableExtend(confirmation, {
        [TYPE]: confirmationType,
        mortgageNumber: utils.randomDecimalString(10),
      })

      return confirmation
    default:
      confirmationType = productType + 'Confirmation'
      const formIds = this._getMyForms(productType, state)
        .map(f => {
          return f[TYPE] + '_' + f[CUR_HASH]
        })

      return {
        [TYPE]: confirmationType,
        message: imported
          ? `Imported product: ${productModel.title}`
          : `Congratulations! You were approved for: ${productModel.title}`,
        // customer: customerHash,
        forms: formIds
      }
  }

}

SimpleBank.prototype.requestForm = function (opts) {
  typeforce({
    req: 'RequestState',
    form: 'String'
  }, opts)

  const req = opts.req
  const form = opts.form
  const prompt = this._models[form].subClassOf === 'tradle.MyProduct'
    ? 'Please share the following information'
    : 'Please fill out this form and attach a snapshot of the original document'

  const msg = utils.buildSimpleMsg(
    prompt,
    form
  )

  debug('requesting form', form)
  return this.bank.send({
    req: req,
    msg: msg
  })
}

SimpleBank.prototype._getRelevantPending = function (pending, reqState) {
  var docType = reqState[TYPE] === types.VERIFICATION
    ? getType(reqState.parsed.data.document)
    : reqState[TYPE]

  var state = reqState && reqState.state
  return find(pending, productType => {
    if (productType === REMEDIATION) {
      return state && state.prefilled && state.prefilled[docType]
    }

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
    [CUR_HASH]: msg[CUR_HASH],
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
  this._destroyed = true
  return this.bank.destroy()
}

SimpleBank.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this.tim.name())
  return debug.apply(null, args)
}

SimpleBank.prototype.storeGuestSession = function (hash, data) {
  return this.bank._setResource(GUEST_SESSION, hash, data)
}

SimpleBank.prototype.importSession = function (req) {
  const bank = this.bank
  const hash = req.parsed.data.session
  const customerHash = req.from[ROOT_HASH]
  const state = req.state
  const msg = req.msg
  let applications
  let forms
  let products
  let verifications
  let confirmations
  return this.bank._getResource(GUEST_SESSION, hash)
    .then(session => {
      state.prefilled = state.prefilled || {}
      const hasUnknownType = find(session, data => {
        return !this._models[data[TYPE]]
      })

      if (hasUnknownType) {
        throw new Error(`unknown type ${hasUnknownType[TYPE]}`)
      }

      forms = session.filter(data => {
        return this._models[data[TYPE]].subClassOf === 'tradle.Form'
      })

      // products = session.filter(data => {
      //   return this._models[data[TYPE]].subClassOf === 'tradle.MyProduct'
      // })

      // products.forEach(product => {
      //   const pType = product[TYPE]
      //   if (!state.importedProducts) state.importedProducts = {}
      //   if (!state.importedProducts[pType]) state.importedProducts[pType] = []

      //   state.importedProducts[pType].push(product)
      // })

      // forms.concat(products).forEach(data => {
      forms.forEach(data => {
        state.prefilled[data[TYPE]] = {
          form: data
        }
      })

      verifications = session.filter(data => data[TYPE] === types.VERIFICATION)
      verifications.forEach(verification => {
        const type = verification.document[TYPE]
        const prefilled = state.prefilled[type]
        if (prefilled) {
          prefilled.verification = verification
        }
      })

      applications = session.map(data => {
        if (data[TYPE] !== types.SIMPLE_MESSAGE) return

        const productType = utils.parseSimpleMsg(data.message).type
        if (productType && this._productList.indexOf(productType) !== -1) {
          return productType
        }
      })
      .filter(obj => obj) // filter out nulls

      // confirmations = session.map(data => {
      //   return data[TYPE].indexOf('Confirmation') !== -1
      // })

      // confirmations.forEach(c => {
      // })

      // save now just in case
      return this.bank._setCustomerState(req)
    })
    .then(() => {
      // async, no need to wait for this
      // this.bank._delResource(GUEST_SESSION, hash)

      if (applications.length) {
        // TODO: queue up all the products
        req.productType = applications[0]
        let sendMsg
        if (req.productType === REMEDIATION) {
          sendMsg = this.bank.send({
            req: req,
            msg: {
              _t: types.SIMPLE_MESSAGE,
              message: 'Thank you for choosing to import your data into the Tradle app. ' +
                'This will save you time when applying for financial products, and enable providers to approve you faster!',
            }
          })
        }

        return (sendMsg || Q())
          .then(() => this.handleNewApplication(req))
      }

      // else if (forms.length) {
      //   // TODO: unhack this crap as soon as we scrap `sync`
      //   var docReq = new RequestState({
      //     from: senderInfo,
      //     parsed: {
      //       data: forms[0]
      //     },
      //     // data: msgBuf
      //   })

      //   for (var p in req) {
      //     if (!(p in docReq)) delete req[p]
      //   }

      //   for (var p in docReq) {
      //     if (typeof docReq[p] !== 'function') {
      //       req[p] = docReq[p]
      //     }
      //   }

      //   return this.handleDocument(req)
      // }
    })
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
