'use strict'

const util = require('util')
const EventEmitter = require('events').EventEmitter
const crypto = require('crypto')
const typeforce = require('typeforce')
const extend = require('xtend')
const mutableExtend = require('xtend/mutable')
const collect = require('stream-collector')
const Q = require('q')
const clone = require('clone')
const tradle = require('@tradle/engine')
const protocol = tradle.protocol
const tradleUtils = tradle.utils
const constants = tradle.constants
const DEFAULT_PRODUCT_LIST = [
  'tradle.CurrentAccount',
  'tradle.BusinessAccount',
  'tradle.Mortgage',
  'tradle.JumboMortgage'
]

// const tradleUtils = require('@tradle/utils')
// const Identity = require('@tradle/identity').Identity
const Bank = require('./')
const utils = require('./lib/utils')
const Actions = require('./lib/actionCreators')
const find = utils.find
const RequestState = require('./lib/requestState')
const getNextState = require('./lib/reducers')
const debug = require('./debug')
const ROOT_HASH = constants.ROOT_HASH
const CUR_HASH = constants.CUR_HASH
const SIG = constants.SIG
const SIGNEE = constants.SIGNEE
const TYPE = constants.TYPE
const types = require('./lib/types')
const GUEST_SESSION_PROOF = types.GUEST_SESSION_PROOF
const FORGET_ME = types.FORGET_ME
const FORGOT_YOU = types.FORGOT_YOU
const VERIFICATION = types.VERIFICATION
const CUSTOMER_WAITING = types.CUSTOMER_WAITING
const SIMPLE_MESSAGE = types.SIMPLE_MESSAGE
const NEXT_FORM_REQUEST = types.NEXT_FORM_REQUEST
const GUEST_SESSION = 'guestsession'
const REMEDIATION = types.REMEDIATION
const PRODUCT_APPLICATION = types.PRODUCT_APPLICATION
const IDENTITY_PUBLISH_REQUEST = types.IDENTITY_PUBLISH_REQUEST
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

  tradleUtils.bindFunctions(this)
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

  // this._employees = opts.employees
  this.tim = opts.node
  var bank = this.bank = new Bank(opts)
  this._ready = this._ensureEmployees(opts.employees)

  bank._shouldChainReceivedMessage = (msg) => {
    return msg[TYPE] === VERIFICATION ||
      this._models.docs.indexOf(msg[TYPE]) !== -1
  }

  bank.use((req, res) => {
    // assign relationship manager if none is assigned
    if (req.state && !req.state.relationshipManager && this._employees.length) {
      // for now, just assign first employee
      req.state = getNextState(req.state, Actions.assignRelationshipManager(this._employees[0]))
    }

    if (this._models.docs.indexOf(req.type) !== -1) {
      return this.handleDocument(req)
    }
  })

  bank.use(NEXT_FORM_REQUEST, this.onNextFormRequest)
  // bank.use('tradle.GetMessage', this.lookupAndSend)
  // bank.use('tradle.GetHistory', this.sendHistory)
  bank.use('tradle.GetEmployee', this.getEmployee)
  bank.use(GUEST_SESSION_PROOF, this.importSession)
  bank.use(FORGET_ME, this.forgetMe)
  bank.use(VERIFICATION, this.handleVerification)
  bank.use(CUSTOMER_WAITING, this.sendProductList)
  bank.use(PRODUCT_APPLICATION, (req) => {
    var product = req.payload.object.product
    if (this._productList.indexOf(product) === -1) {
      return this.replyNotFound(req, product)
    } else {
      req.productType = product
      return this.handleNewApplication(req)
    }
  })

  bank.use(SIMPLE_MESSAGE, (req) => {
    var msg = req.payload.object.message
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
          _t: SIMPLE_MESSAGE,
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

  // bank.use(req => {
  //   if (!this._employees.length) return

  //   const from = req.payload.author.permalink
  //   const isEmployee = this._employees.some(e => e.permalink === from)
  //   if (isEmployee) return

  //   const relationshipManager = req.state.relationshipManager
  //   if (relationshipManager) {
  //     return this.tim.send({
  //       to: { permalink: relationshipManager },
  //       link: req.payload.link
  //     })
  //   }
  // })

  // bank.use(types.REQUEST_FOR_REPRESENTATIVE, function (req) {
  //   // Find represntative
  //   return bank.send(req, {
  //     _t: SIMPLE_MESSAGE,
  //     welcome: true,
  //     // message: '[Hello! It very nice to meet you](Please choose the product)',
  //     message: 'The feature of switching to representative is coming soon!',
  //   })
  // })
}

module.exports = SimpleBank
util.inherits(SimpleBank, EventEmitter)

SimpleBank.prototype.receiveMsg = function (msg, senderInfo, sync) {
  if (Buffer.isBuffer(msg)) msg = protocol.unserializeMessage(msg)
  return this._ready.then(() => {
    return this._receiveMsg(msg, senderInfo, sync)
  })
}

SimpleBank.prototype._receiveMsg = function (msg, senderInfo, sync) {
  var bank = this.bank
  const obj = msg.object
  const type = obj[TYPE]
  if (type !== IDENTITY_PUBLISH_REQUEST) {
    return this.receivePrivateMsg(msg, senderInfo, sync)
  }

  // if it's an identity, store it
  // if (msg[TYPE] !== IDENTITY_PUBLISH_REQUEST) {
  //   var errMsg = utils.format('rejecting cleartext {0}, only {1} are accepted in cleartext',
  //       msg[TYPE],
  //       IDENTITY_PUBLISH_REQUEST)

  //   this._debug(errMsg)
  //   return utils.rejectWithHttpError(400, errMsg)
  // }

  // if (msg[ROOT_HASH] && senderInfo[ROOT_HASH] && msg[ROOT_HASH] !== senderInfo[ROOT_HASH]) {
  //   return utils.rejectWithHttpError(401, 'sender doesn\'t match identity embedded in message')
  // }

  // fake chainedObj format
  var req = new RequestState({
    author: senderInfo,
    sync: sync,
    object: msg
  })

  try {
    req.from.identity = obj.identity
  } catch (err) {
    return utils.rejectWithHttpError(400, 'invalid identity')
  }

  const from = senderInfo.permalink || senderInfo.fingerprint
  return this.bank._lock(from, 'publish identity')
    .then(() => this.publishCustomerIdentity(req))
//     .then(() => this.sendProductList(req))
    .finally(() => req.end())
    .finally(() => this.bank._unlock(from))
}

SimpleBank.prototype._ensureEmployees = function (employees) {
  var self = this
  return (employees ? Q(employees) : getEmployees())
    .then(_employees => {
      employees = _employees
      return Q.all(employees.map(e => {
        return this.tim.addressBook.lookupIdentity(e)
          .catch(() => this.tim.addContactIdentity(e.identity))
      }))
    })
    .then(() => {
      this._employees = employees
      this.bank.setEmployees(employees)
    })

  function getEmployees () {
    return Q.nfcall(collect, self.tim.objects.type('tradle.MyEmployeePass'))
      .then(employees => {
        return employees.filter(e => {
          // issued by "me" (the bank bot)
          return e.author === self.tim.permalink
        })
        .map(e => {
          const pass = e.object
          return {
            [ROOT_HASH]: e.object.customer,
            pub: e.to.identity,
            profile: {
              name: utils.pick(pass, 'firstName', 'lastName')
            },
            // txId: e.to.txId
          }
        })
      })
  }
}

SimpleBank.prototype.receivePrivateMsg = function (msg, senderInfo, sync) {
  return this.tim.addressBook.lookupIdentity(senderInfo)
    .then(
      them => {
        return this.bank.receiveMsg(msg, them, sync)
      },
      err => {
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
    .filter(productModelId => productModelId !== REMEDIATION && productModelId !== 'tradle.EmployeeOnboarding')
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

  let name // = req.from.identity.name()
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
      list: list
    }
  })
}

SimpleBank.prototype.publishCustomerIdentity = function (req) {
  // TODO: verify that sig of identityPublishRequest comes from sign/update key
  // of attached identity. Need to factor this out of @tradle/verifier
  var self = this
  var bank = this.bank
  var identity = req.payload.object.identity
  var tim = this.tim
  var rootHash
  var wasAlreadyPublished
  var curHash = protocol.linkString(identity)
  var rootHash = identity[ROOT_HASH] || curHash
  return Q.all([
      tim.objects.get(curHash).catch(noop),
      tim.addContactIdentity(identity)
      // tim.keeper.push && tim.keeper.push({ key: curHash, value: buf })
    ])
    .spread(function (obj) {
      // if obj is queued to be chained
      // assume it's on its way to be published
      if (obj && 'sealstatus' in obj) {
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
    return tim.seal({ link: curHash })
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
  typeforce({
    productType: 'String'
  }, req)

  req.state = getNextState(req.state, Actions.newApplication(req.productType))
  return this.sendNextFormOrApprove({req})
}

SimpleBank.prototype.handleDocument = function (req, res) {
  const bank = this.bank
  const type = req.type
  const state = req.state
  const msg = req.msg
  const next = () => {
    req.state = getNextState(req.state, Actions.receivedForm(req))

    const prefilledVerification = utils.getImportedVerification(state, req.payload)
    if (!prefilledVerification && !this._auto.verify) {
      return this.sendNextFormOrApprove({req})
    }

    return this._sendVerification({
      req: req,
      verifiedItem: req.payload
    })
    .then(() => {
      return this.sendNextFormOrApprove({req})
    })
    // .then(() => {
    //   req.state = getNextState(req.state, Actions.sentVerification(msg))
    // })
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

SimpleBank.prototype.onNextFormRequest = function (req, res) {
  req.state = getNextState(req.state, Actions.skipForm(this._models, req.payload.object.after))
  return this.sendNextFormOrApprove({req})
}

SimpleBank.prototype.validateDocument = function (req) {
  const doc = req.payload.object
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
  const verifiedItem = opts.verifiedItem
  if (!utils.findFormState(req.state.forms, verifiedItem.link)) {
    debugger
    return utils.rejectWithHttpError(400, new Error('form not found'))
  }

  let action = Actions.createVerification(verifiedItem, this.tim.identity)
  req.state = getNextState(req.state, action)
  const verification = utils.lastVerificationFor(req.state.forms, verifiedItem.link)

  return this.bank.send({
      req: req,
      msg: verification.body
    })
    .then(sentVerification => {
      let action = Actions.sentVerification(verifiedItem, verification, sentVerification.object)
      req.state = getNextState(req.state, action)
      this.tim.seal({ link: sentVerification.object.link })
    })
}

SimpleBank.prototype.sendVerification = function (opts) {
  typeforce({
    verifiedItem: typeforce.oneOf('String', 'Object')
  }, opts)

  const lookup = typeof opts.verifiedItem === 'string'
    ? this.tim.objects.get(opts.verifiedItem)
    : opts.verifiedItem

  let verifiedItem
  let req
  return lookup
    .then(_verifiedItem => {
      verifiedItem = _verifiedItem
      req = new RequestState(null, verifiedItem)
      return this.bank._lock(verifiedItem.author)
    })
    .then(() => {
      return this.bank._getCustomerState(verifiedItem.author)
    })
    .then(state => {
      req.state = state
      return this._sendVerification({
        req: req,
        verifiedItem: verifiedItem
      })
    })
    .then(() => {
      return this.bank._setCustomerState(req)
    })
    .finally(() => req && req.end())
    .finally(() => {
      if (verifiedItem && verifiedItem.author) {
        return this.bank._unlock(verifiedItem.author)
      }
    })
}

SimpleBank.prototype.requestEdit = function (req, errs) {
  typeforce({
    message: 'String',
    errors: '?Array'
  }, errs)

  const prefill = req.payload.object
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
  let state = (req || opts).state
  const pendingApps = state.pendingApplications
  if (!pendingApps.length) {
    return Q()
  }

  let productType = opts.productType
  if (req && !productType) {
    productType = req.productType
    if (!productType) {
      var product = this._getRelevantPending(pendingApps, req)
      productType = product && product.type
    }
  }

  if (!productType) {
    return utils.rejectWithHttpError(400, 'unable to determine product requested')
  }

  const application = utils.find(pendingApps, app => app.type === productType)
  const isRemediation = productType === REMEDIATION
  const productModel = isRemediation ? REMEDIATION_MODEL : this._models[productType]
  if (!productModel) {
    return utils.rejectWithHttpError(400, 'no such product model: ' + productType)
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
  // else if (productType !== REMEDIATION) {
  //   state.products[productType] = []
  // }

  if (req.type === VERIFICATION) return Q()

  const isFormOrVerification = req[TYPE] === VERIFICATION || this._models.docs.indexOf(req[TYPE]) !== -1
  const reqdForms = isRemediation
    ? Object.keys(state.prefilled)
    : utils.getForms(productModel)

  const multiEntryForms = productModel.multiEntryForms || []
  const missing = utils.find(reqdForms, type => {
    if (multiEntryForms.indexOf(type) !== -1) {
      return application.skip.indexOf(type) === -1
    }

    return !utils.findLast(state.forms, form => form.type === type)
  })

  if (missing) {
    if (!this._auto.prompt) return Q()

    const prefilled = state.prefilled[missing]
    if (prefilled) {
      const docReq = new RequestState({
        [TYPE]: missing,
        state: state,
        author: req.from,
        to: req.to,
        sync: req.sync,
        customer: req.customer,
        productType: productType,
        // parsed: {
        //   data: prefilled.form
        // }
      }, { object: prefilled.form })

      // TODO: figure out how to continue on req
      docReq.promise = req.promise.bind(req)
      return this.handleDocument(docReq)
    }

    return this.requestForm({
      req: req,
      form: missing,
      productModel: productModel
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
    // take latest form
    const form = utils.findLast(state.forms, form => form.type === f).form
    const props = utils.pick(form, 'body')
    props[CUR_HASH] = form.link
    return props
  })

  this.emit('application', {
    customer: req.payload.author.permalink,
    productType: productType,
    forms: forms,
    req: this._auto.verify ? null : req
  })

  if (!this._auto.verify || productType === 'tradle.EmployeeOnboarding') {
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
    const docState = utils.findLast(state.forms, form => form.type === f)
    const verifications = docState.verifications
    if (verifications && verifications.length) {
      let formId = verifications[0].body.document.id
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
  const productType = opts.productType
  return this.bank._lock(customerHash, 'approve product')
    .then(() => this.bank._getCustomerState(customerHash))
    .then(state => {
      const existing = state.products[productType]
      if (existing && existing.length) {
        throw new Error('customer already has this product')
      }

      req = new RequestState({
        state: state,
        author: {
          permalink: customerHash
        }
      })

      return this._approveProduct({
        req: req,
        productType: productType
      })
    })
    .then(() => this.bank._setCustomerState(req))
    .finally(() => req && req.end())
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
  let state = req.state
  const productType = opts.productType
  const productModel = this._models[productType]
  const missingForms = utils.getMissingForms(state, productModel)
  if (missingForms.length) {
    return utils.rejectWithHttpError(400, 'request the following forms first: ' + missingForms.join(', '))
  }

  const missingVerifications = utils.getUnverifiedForms(this.tim.identity, state, productModel)
  if (missingVerifications.length) {
    const types = missingVerifications.map(f => f.type).join(', ')
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

  debug('approving for product', productType)
  req.state = state = getNextState(state, Actions.approveProduct(productType))
  const confirmation = this._newProductConfirmation(state, productType)

  return this.bank.send({
    req: req,
    msg: confirmation
  })
  .then(result => {
    const pOfType = state.products[productType]
    req.state = state = getNextState(state, Actions.approvedProduct({
      product: utils.last(pOfType),
      rootHash: result.object.link
    }))

    return result
  })
}

SimpleBank.prototype._newProductConfirmation = function (state, productType) {
  const productModel = this._models[productType]
  const forms = state.forms

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

  let confirmation = {
    customer: state.permalink
  }

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
    case 'tradle.EmployeeOnboarding':
      confirmationType = 'tradle.MyEmployeePass'
      copyProperties(confirmation, confirmationType)
      mutableExtend(confirmation, {
        [TYPE]: confirmationType,
        employeeID: utils.randomDecimalString(10),
      })
      return confirmation
    default:
      const guessedMyProductModel = this._models[productType.replace('.', '.My')]
      if (guessedMyProductModel && guessedMyProductModel.subClassOf === 'tradle.MyProduct') {
        confirmation[TYPE] = confirmationType = guessedMyProductModel.id
        copyProperties(confirmation, confirmationType)
        return confirmation
      }

      confirmationType = productType + 'Confirmation'
      const formIds = this._getMyForms(productType, state)
        .map(f => {
          return f[TYPE] + '_' + f[CUR_HASH]
        })

      return {
        [TYPE]: confirmationType,
        // message: imported
        //   ? `Imported product: ${productModel.title}`
        message: `Congratulations! You were approved for: ${productModel.title}`,
        forms: formIds
      }
  }

}

SimpleBank.prototype.requestForm = function (opts) {
  typeforce({
    req: 'RequestState',
    form: 'String',
    productModel: typeforce.Object
  }, opts)

  const req = opts.req
  const form = opts.form
  const productModel = opts.productModel
  const multiEntryForms = opts.productModel.multiEntryForms || []
  const isMultiEntry = multiEntryForms.indexOf(opts.form) !== -1
  const prompt = this._models[form].subClassOf === 'tradle.MyProduct' ? 'Please share the following information' :
    // isMultiEntry ? 'Please fill out this form and attach a snapshot of the original document' :
    'Please fill out this form and attach a snapshot of the original document'

  const msg = {
    [TYPE]: 'tradle.FormRequest',
    message: prompt,
    product: productModel.id,
    form: form
  }

  debug('requesting form', form)
  return this.bank.send({
    req: req,
    msg: msg
  })
}

SimpleBank.prototype._getRelevantPending = function (pending, reqState) {
  var docType = reqState[TYPE] === VERIFICATION ? getType(reqState.payload.object.document)
    : reqState[TYPE] === 'tradle.NextFormRequest' ? reqState.payload.object.after
    : reqState[TYPE]

  var state = reqState && reqState.state
  return find(pending, product => {
    if (product.type === REMEDIATION) {
      return state && state.prefilled && state.prefilled[docType]
    }

    return this._models.docs[product.type].indexOf(docType) !== -1
  })
}

// SimpleBank.prototype.lookupAndSend = function (req) {
//   var bank = this.bank
//   var tim = this.tim
//   var info = {}
//   var from = req.payload.author.permalink
//   var curHash = req.payload.hash

//   return Q.ninvoke(tim.messages(), 'byCurHash', curHash, true /* all from/to */)
//     .then(function (infos) {
//       var match
//       var found = infos.some(function (info) {
//         // check if they're allowed to see this message
//         if ((info.from && info.author.permalink
//           (info.to && info.to[ROOT_HASH] === from)) {
//           match = info
//           return true
//         }
//       })

//       if (!match) throw new Error('not found')

//       return tim.lookupObject(match)
//     })
//     .catch(function (err) {
//       debug('msg not found', err)
//       var httpErr = new Error('not found')
//       httpErr.code = 404
//       throw httpErr
//     })
//     .then(function (obj) {
//       return bank.send({
//         req: req,
//         msg: obj.payload
//       })
//     })
// }

// SimpleBank.prototype.sendHistory = function (req) {
//   var bank = this.bank
//   var senderRootHash = req.payload.author.permalink
//   var from = {}
//   from[ROOT_HASH] = senderRootHash
//   return this.tim.history(from)
//     .then(function (objs) {
//       return Q.all(objs.map(function (obj) {
//         return bank.send({
//           req: req,
//           msg: obj.payload
//         })
//       }))
//     })
// }

SimpleBank.prototype.employees = function () {
  return (this._employees || []).slice()
}

SimpleBank.prototype.getEmployee = function (req) {
  var bank = this.bank
  var employeeIdentifier = req.payload.object.employee
  var employeeInfo = find(this._employees, info => {
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
  // dangerous if verification is malformed
  if (!utils.findFormState(req.state.forms, req.payload.object.document.id.split('_')[1])) {
    debugger
    return utils.rejectWithHttpError(400, new Error('form not found'))
  }

  req.state = getNextState(req.state, Actions.receivedVerification(req.payload))
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
  args.unshift(this.tim.name)
  return debug.apply(null, args)
}

SimpleBank.prototype.storeGuestSession = function (hash, data) {
  return this.bank._setResource(GUEST_SESSION, hash, data)
}

SimpleBank.prototype.importSession = function (req) {
  const bank = this.bank
  const hash = req.payload.object.session
  const customerHash = req.payload.author.permalink
  const state = req.state
  const msg = req.msg
  let applications
  let session
  return this.bank._getResource(GUEST_SESSION, hash)
    .then(_session => {
      session = _session
      req.state = getNextState(req.state, Actions.importSession(session, this._models))
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

      const applications = session.map(data => {
        if (data[TYPE] !== SIMPLE_MESSAGE) return

        const productType = utils.parseSimpleMsg(data.message).type
        if (productType && this._productList.indexOf(productType) !== -1) {
          return productType
        }
      })
      .filter(obj => obj) // filter out nulls}

      if (applications.length) {
        // TODO: queue up all the products
        req.productType = applications[0]
        let sendMsg
        if (req.productType === REMEDIATION) {
          sendMsg = this.bank.send({
            req: req,
            msg: {
              [TYPE]: SIMPLE_MESSAGE,
              message: 'Please check and correct the following data'
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

function ensureFormType (state, type) {
  if (!state.forms[type]) state.forms[type] = []

  return state.forms[type]
}

function ensureFormState (forms, curHash) {
  var formState = findFormState(forms, curHash)
  if (!formState) {
    formState = { [CUR_HASH]: curHash }
    forms.push(formState)
  }

  return formState
}

function newApplicationState (type) {
  { type }
}
