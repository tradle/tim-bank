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

const createContextDB = require('@tradle/message-context')

// const tradleUtils = require('@tradle/utils')
// const Identity = require('@tradle/identity').Identity
const Bank = require('./')
const utils = require('./lib/utils')
const Actions = require('./lib/actionCreators')
const find = utils.find
const RequestState = require('./lib/requestState')
const getNextState = require('./lib/reducers')
const defaultPlugins = require('./lib/defaultPlugins')
const debug = require('./debug')
const ROOT_HASH = constants.ROOT_HASH
const CUR_HASH = constants.CUR_HASH
const SIG = constants.SIG
const SIGNEE = constants.SIGNEE
const TYPE = constants.TYPE
const PREVLINK = constants.PREVLINK
const PERMALINK = constants.PERMALINK
const MESSAGE_TYPE = constants.TYPES.MESSAGE
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
const SELF_INTRODUCTION = 'tradle.SelfIntroduction'
const REMEDIATION_MODEL = {
  [TYPE]: 'tradle.Model',
  id: REMEDIATION,
  subClassOf: 'tradle.FinancialProduct',
  interfaces: [MESSAGE_TYPE],
  forms: []
}

const noop = function () {}

function SimpleBank (opts) {
  if (!(this instanceof SimpleBank)) {
    return new SimpleBank(opts)
  }

  tradleUtils.bindFunctions(this)
  EventEmitter.call(this)

  this._validate = opts.validate !== false
  this._auto = extend({
    // approve: true,
    prompt: true,
    verify: true
  }, opts.auto)

  const rawModels = (opts.models || []).concat(REMEDIATION_MODEL)
  this.models = Object.freeze(utils.processModels(rawModels))

  this._productList = (opts.productList || DEFAULT_PRODUCT_LIST).slice()
  this._productList.push(REMEDIATION)

  const missingProduct = find(this._productList, p => !this.models[p])
  if (missingProduct) {
    throw new Error(`missing model for product: ${missingProduct}`)
  }

  // this._employees = opts.employees
  this.tim = this.node = opts.node
  var bank = this.bank = new Bank(opts)
  this._ready = this._ensureEmployees(opts.employees)

  // TODO: plugin-ize
  bank._shouldChainReceivedMessage = (msg) => {
    return msg[TYPE] === VERIFICATION ||
      this.models.docs.indexOf(msg[TYPE]) !== -1
  }

  bank.use((req, res) => {
    if (this.models.docs.indexOf(req.type) !== -1) {
      return this.handleDocument(req)
    }
  })

  bank.use('tradle.Introduction', req => {
    // danger!
    return this.tim.addContactIdentity(req.payload.object.identity)
  })

  bank.use(IDENTITY_PUBLISH_REQUEST, this._setProfile)
  bank.use(IDENTITY_PUBLISH_REQUEST, this.publishCustomerIdentity)
  bank.use(IDENTITY_PUBLISH_REQUEST, this.sendProductList)

  bank.use(SELF_INTRODUCTION, this._setProfile)
  bank.use(SELF_INTRODUCTION, this.sendProductList)

  bank.use(this._assignRelationshipManager)

  bank.use(NEXT_FORM_REQUEST, this.onNextFormRequest)
  // bank.use('tradle.GetMessage', this.lookupAndSend)
  // bank.use('tradle.GetHistory', this.sendHistory)
  bank.use('tradle.GetEmployee', this.getEmployee)
  bank.use(GUEST_SESSION_PROOF, this.importSession)
  bank.use(FORGET_ME, this.forgetMe)
  bank.use(VERIFICATION, this.handleVerification)
  bank.use(CUSTOMER_WAITING, req => {
    if (!req.context) return this.sendProductList(req)
  })

  bank.use(PRODUCT_APPLICATION, (req) => {
    var product = req.payload.object.product
    if (this._productList.indexOf(product) === -1) {
      return this.replyNotFound(req, product)
    } else {
      req.productType = product
      return this.handleNewApplication(req)
    }
  })

  // bank.use(req => {
  //   if (Bank.NO_FORWARDING || !this._employees.length) return

  //   let type = req.payload.object[TYPE]
  //   if (type === IDENTITY_PUBLISH_REQUEST || type === SELF_INTRODUCTION
  //       // || type === 'tradle.Message'
  //       || type === 'tradle.ShareContext'
  //   ) {
  //     return
  //   }

  //   const from = req.payload.author.permalink
  //   const isEmployee = this._employees.some(e => e[ROOT_HASH] === from)
  //   if (isEmployee) return

  //   const relationshipManager = req.state.relationshipManager
  //   if (!relationshipManager) return

  //   const obj = req.msg.object.object
  //   const embeddedType = obj[TYPE] === MESSAGE_TYPE && obj.object[TYPE]
  //   const context = req.context
  //   const other = context && { context }
  //   type = embeddedType || req[TYPE]
  //   this._debug(`FORWARDING ${type} FROM ${req.customer} TO RM ${relationshipManager}`)
  //   this.tim.send({
  //     to: { permalink: relationshipManager },
  //     link: req.payload.link,
  //     // bad: this creates a duplicate message in the context
  //     other: other
  //   })
  // })

  bank.use('tradle.Message', this._handleSharedMessage)
  bank.use('tradle.ShareContext', this.shareContext)

  // bank.use(req => {
  //   const relationshipManager = req.state.relationshipManager
  //   if (!relationshipManager) return

  //   req.sent.forEach(msg => {
  //     debugger
  //     // this._debug(`FORWARDING SELF-SENT ${type} TO RM ${relationshipManager}`)
  //     // this.tim.send({
  //     //   to: { permalink: relationshipManager },
  //     //   object: msg.object,
  //     //   // bad: this creates a duplicate message in the context
  //     //   other: other
  //     // })
  //   })
  // })

  // bank.use(SIMPLE_MESSAGE, (req) => {
  //   var msg = req.payload.object.message
  //   if (!msg) return

  //   var parsed = utils.parseSimpleMsg(msg)
  //   if (parsed.type) {
  //     if (this._productList.indexOf(parsed.type) === -1) {
  //       return this.replyNotFound(req, parsed.type)
  //     } else {
  //       req.productType = parsed.type
  //       return this.handleNewApplication(req)
  //     }
  //   }
  //   else {
  //     return bank.send({
  //       req: req,
  //       msg: {
  //         _t: SIMPLE_MESSAGE,
  //         welcome: true,
  //         // message: '[Hello! It very nice to meet you](Please choose the product)',
  //         message: 'Switching to representative mode is not yet implemented.',
  //       }
  //     })
  //     // return bank.send(req, {
  //     //   _t: types.REQUEST_FOR_REPRESENTATIVE,
  //     //   welcome: true,
  //     //   message: 'Switching to representative mode is not yet implemented'
  //     // })
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

  this._plugins = []

  // default plugins
  this.use(defaultPlugins)
  this._shareContexts()
  this._forwardToCustomer()
  this._forwardToRelationshipManager()
}

module.exports = SimpleBank
util.inherits(SimpleBank, EventEmitter)

SimpleBank.prototype.receiveMsg = function (msg, senderInfo, sync) {
  const self = this
  if (Buffer.isBuffer(msg)) msg = tradleUtils.unserializeMessage(msg)

  const obj = msg.object
  const type = obj[TYPE]
  this._debug('receiving ' + type)

  const from = senderInfo.permalink || senderInfo.fingerprint || senderInfo.pubKey
  return this._ready.then(() => {
    if (type === SELF_INTRODUCTION || type === IDENTITY_PUBLISH_REQUEST) {
      return this._wrapInLock(from, () => this.tim.addContactIdentity(obj.identity))
        .then(receivePrivate)
    } else {
      return receivePrivate()
    }
  })

  function receivePrivate () {
    return self.receivePrivateMsg(msg, senderInfo, sync)
  }
}

SimpleBank.prototype._assignRelationshipManager = function (req) {
  // assign relationship manager if none is assigned
  const from = req.payload.author.permalink
  const isEmployee = this._employees.some(e => e[ROOT_HASH] === from)
  if (isEmployee) return

  let relationshipManager = req.state.relationshipManager
  const rmIsStillEmployed = relationshipManager && this._employees.some(e => e[ROOT_HASH] === relationshipManager)
  if (relationshipManager && !rmIsStillEmployed) {
    this._toggleForwarding({
      customer: req.customer,
      employee: relationshipManager,
      on: false
    })

    relationshipManager = null
  }

  const needsNewRM = !Bank.NO_FORWARDING && req.state && !relationshipManager && this._employees.length
  if (!needsNewRM) return

  // for now, just assign first employee
  const idx = Math.floor(Math.random() * this._employees.length)
  req.state = getNextState(req.state, Actions.assignRelationshipManager(this._employees[idx]))
  // no need to wait for this to finish
  // console.log('ASSIGNED RELATIONSHIP MANAGER TO ' + req.customer)

  relationshipManager = req.state.relationshipManager
  this.tim.signAndSend({
    to: { permalink: relationshipManager },
    object: {
      [TYPE]: 'tradle.Introduction',
      profile: req.state.profile,
      name: req.state.profile ? null : 'Customer ' + utils.randomDecimalString(6),
      message: 'Your new customer',
      // [TYPE]: 'tradle.Introduction',
      // relationship: 'customer',
      identity: req.from.object
    }
  })

  this._toggleForwarding({
    customer: req.customer,
    employee: relationshipManager,
    on: true
  })
}

SimpleBank.prototype._wrapInLock = function (locker, fn) {
  return this.bank._lock(locker)
    .then(() => fn())
    .finally(() => this.bank._unlock(locker))
}

SimpleBank.prototype._setEmployees = function (employees) {
  this._employees = employees
  this.bank.setEmployees(employees)
}

SimpleBank.prototype._ensureEmployees = function (employees) {
  var self = this
  return (employees ? Q(employees) : getEmployees())
    .then(this._setEmployees)

  function getEmployees () {
    let employees
    return self.getMyEmployees()
      .then(_employees => {
        employees = _employees
        return Q.all(employees.map(e => {
          return self.tim.addressBook.byPermalink(e.object.customer)
        }))
      })
      .then(identities => {
        return identities.map(function (identityInfo, i) {
          const e = employees[i]
          const pass = e.object
          return {
            [ROOT_HASH]: e.object.customer,
            pub: identityInfo.object,
            profile: {
              name: utils.pick(pass, 'firstName', 'lastName')
            },
            // txId: e.to.txId
          }
        })
      })
      .catch(err => {
        debugger
        throw err
      })
  }
}

SimpleBank.prototype._setProfile = function (req, res) {
  const profile = req.payload.object.profile
  if (!profile) return

  const action = Actions.setProfile(profile)
  req.state = getNextState(req.state, action)
}

SimpleBank.prototype.getMyEmployees = function () {
  const self = this
  return Q.nfcall(collect, this.tim.objects.type('tradle.MyEmployeeOnboarding'))
    .then(employees => {
      return employees.filter(e => {
      // issued by "me" (the bank bot)
        return e.author === self.tim.permalink && !e.object.revoked
      })
    })
}

SimpleBank.prototype.receivePrivateMsg = function (msg, senderInfo, sync) {
  return this.tim.addressBook.lookupIdentity(senderInfo)
    .then(
      them => {
        return this.bank.receiveMsg(msg, them, sync)
      },
      err => {
        const req = new RequestState({ author: senderInfo })
        return this.replyNotFound(req)
      }
    )
}

SimpleBank.prototype.replyNotFound = function (req, whatWasntFound) {
  return this.send({
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
      var model = this.models[productModelId]
      var forms = utils.getForms(model)
      forms.forEach(formModelId => {
        if (this.models[formModelId]) {
          // avoid duplicates by using object
          formModels[formModelId] = this.models[formModelId]
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
      [TYPE]: types.PRODUCT_LIST,
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
  tim.objects.get(curHash)
    .catch(noop)
    .then(function (obj) {
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
    // .then(() => this.sendProductList(req))
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

  const productType = req.productType
  const pendingApp = find(req.state.pendingApplications || [], app => app.type === productType)
  if (pendingApp) {
    req.context = pendingApp.permalink
    return this.sendNextFormOrApprove({req})
  }

  const permalink = req.payload.permalink
  req.state = getNextState(req.state, Actions.newApplication(productType, permalink))
  req.context = permalink
  return this.sendNextFormOrApprove({req})
}

SimpleBank.prototype.handleDocument = function (req, res) {
  const appLink = req.context
  const application = req.application
  if (!application || application.isProduct) {
    // TODO: save in prefilled documents
    return utils.rejectWithHttpError(400, new Error(`application ${appLink} not found`))
  }

  let state = req.state
  const next = () => {
    req.state = state = getNextState(req.state, Actions.receivedForm(req.payload, appLink))

    if (!utils.isVerifiableForm(this.models[req.type])) {
      return
    }

    const prefilledVerification = utils.getImportedVerification(state, req.payload.object)
    if (!prefilledVerification && !this._auto.verify) {
      return
    }

    // get updated application state
    return this.shouldSendVerification({
        state,
        application: req.application,
        form: utils.findFormState(req.application.forms, req.payload.link)
      })
      .then(should => {
        return should.result && this._sendVerification({
          req: req,
          verifiedItem: req.payload
        })
      })

    // .then(() => {
    //   req.state = getNextState(req.state, Actions.sentVerification(msg))
    // })
  }

  let valid = true
  return this.validateDocument(req)
    .then(
      next,
      errs => {
        valid = false
        req.nochain = true
        return this.requestEdit(req, errs)
      }
    )
    .then(() => {
      if (valid) {
        return this.sendNextFormOrApprove({req})
      }
    })
}

SimpleBank.prototype.onNextFormRequest = function (req, res) {
  req.state = getNextState(req.state, Actions.skipForm(this.models, req.payload.object.after))
  return this.sendNextFormOrApprove({req})
}

SimpleBank.prototype.validateDocument = function (req) {
  const doc = req.payload.object
  const type = doc[TYPE]
  const model = this.models[type]
  if (!model) throw new Error(`unknown type ${type}`)

  let err
  if (this._validate) {
    err = utils.validateResource(doc, model)
  }

  if (!err) {
    if (!doc[SIG]) {
      err = {
        message: 'Please take a second to review this data',
        errors: []
      }
    }
  }

  return err ? Q.reject(err) : Q()
}

SimpleBank.prototype._sendVerification = function (opts) {
  typeforce({
    req: 'RequestState',
    verifiedItem: 'Object'
  }, opts)

  const req = opts.req
  const verifiedItem = opts.verifiedItem
  const appLink = req.context
  const application = req.application || req.product
  if (!application) {
    // TODO: save in prefilled verifications
    return utils.rejectWithHttpError(400, new Error(`application ${appLink} not found`))
  }

  if (!utils.findFormState(application.forms, verifiedItem.link)) {
    return utils.rejectWithHttpError(400, new Error('form not found, refusing to send verification'))
  }

  let action = Actions.createVerification(verifiedItem, this.tim.identityInfo, appLink)
  req.state = getNextState(req.state, action)
  const updatedApp = req.application || req.product // dynamically calc'c prop
  const verification = utils.lastVerificationFor(updatedApp.forms, verifiedItem.link)

  return this.send({
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
    verifiedItem: typeforce.oneOf('String', 'Object'),
    application: typeforce.String
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
      req.context = opts.application
      return this.bank._lock(verifiedItem.author)
    })
    .then(() => {
      return this.getCustomerState(verifiedItem.author)
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

  const prefill = clone(req.payload.object)
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

  return this.send({
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
    productType: '?String',
    application: '?String'
  }, opts)

  const req = opts.req
  let state = (req || opts).state
  const context = opts.application || req.context
  const application = utils.getApplication(state, context)
  if (!application) {
    this._debug(`pending application ${context} not found`)
    return Q()
  }

  const productType = application.type
  const isRemediation = productType === REMEDIATION
  const productModel = isRemediation ? REMEDIATION_MODEL : this.models[productType]
  if (!productModel) {
    return utils.rejectWithHttpError(400, 'no such product model: ' + productType)
  }

  const thisProduct = state.products[productType]
  if (thisProduct && thisProduct.length && !productModel.customerCanHaveMultiple) {
    const msg = utils.buildSimpleMsg(
      'You already have a ' + productModel.title + ' with us!'
    )

    return this.send({
      msg: msg,
      req: req
    })
  }
  // else if (productType !== REMEDIATION) {
  //   state.products[productType] = []
  // }

  if (req.type === VERIFICATION) return Q()

  const isFormOrVerification = req[TYPE] === VERIFICATION || this.models.docs.indexOf(req[TYPE]) !== -1
  const reqdForms = isRemediation
    ? Object.keys(state.prefilled)
    : utils.getForms(productModel)

  const multiEntryForms = productModel.multiEntryForms || []
  const missing = find(reqdForms, type => {
    if (multiEntryForms.indexOf(type) !== -1) {
      return application.skip.indexOf(type) === -1
    }

    return !find(application.forms, form => form.type === type)
  })

  if (missing) {
    if (!this._auto.prompt) return Q()

    const isMultiEntry = multiEntryForms.indexOf(missing) !== -1
    let prefilled = !isMultiEntry && utils.findFilledForm(state, missing)
    if (prefilled) {
      const docReq = new RequestState({
        [TYPE]: missing,
        context: context,
        state: state,
        author: req.from,
        to: req.to,
        sync: req.sync,
        customer: req.customer,
        productType: productType,
        // parsed: {
        //   data: prefilled.form
        // }
      }, { object: prefilled })

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

  // const missingVerifications = utils.getUnverifiedForms(this.tim.identity, application, productModel)
  // if (missingVerifications.length) {
  //   const types = missingVerifications.map(f => f.type).join(', ')
  //   this._debug(`still waiting to verify: ${types}`)
  //   return
  // }

  if (isRemediation) {
    const msg = utils.buildSimpleMsg(
      'Thank you for confirming your information with us!'
    )

    debug('finished remediation')
    return this.send({
      req: req,
      msg: msg
    })
  }

  const forms = application.forms.map(wrapper => {
    const form = wrapper.form
    // take latest form
    return {
      body: form.body,
      [CUR_HASH]: form.link
    }
  })

  this.emit('application', {
    customer: req.payload.author.permalink,
    productType: productType,
    application: application,
    forms: forms,
    req: this._auto.verify ? null : req
  })

  if (!this._auto.verify || productType === 'tradle.EmployeeOnboarding') {
    // 'application' event ugly side-effect
    return (req.continue || Q())
      .then(() => this.onApplicationFormsCollected({ req, application }))
  }

  return this.shouldIssueProduct({ state: req.state, application })
    .then(should => {
      return should.result && this._approveProduct({
        application: application,
        req: req
      })
    })
}

SimpleBank.prototype._simulateReq = function (opts) {
  let req
  const customerHash = opts.customer
  return this.getCustomerState(customerHash)
    .then(state => {
      req = new RequestState({
        state: state,
        author: {
          permalink: customerHash
        }
      })

      return this.bank._lock(customerHash)
    })
    .then(() => extend(opts, { req }))
}

SimpleBank.prototype._endRequest = function (opts) {
  return (opts.req ? opts.req.end() : Q())
    .finally(() => this.bank._unlock(opts.customer))
}

SimpleBank.prototype.approveProduct = function (opts) {
  typeforce({
    customer: typeforce.String,
    productType: typeforce.maybe(typeforce.String),
    application: typeforce.maybe(typeforce.String)
  }, opts)

  let req
  let application
  // return this._simulateReq(opts.customer)

  return this._simulateReq(opts)
    .then(updatedOpts => {
      req = updatedOpts.req
      let appLink = opts.application
      application = appLink && utils.getApplication(req.state, appLink)
      if (!application) {
        application = find(req.state.pendingApplications || [], app => app.type === opts.productType)
        if (!application) {
          throw new Error(`pending application ${appLink} not found`)
        } else {
          appLink = application.permalink
        }
      }

      req.context = appLink
      return this._approveProduct({ req, application })
    })
    .then(() => this.bank._setCustomerState(req))
    .finally(() => this._endRequest(opts))
}

SimpleBank.prototype.getProducts = function (opts) {
  typeforce({
    customer: typeforce.String,
  }, opts)

  return this.getCustomerState(opts.customer)
    .then(state => state.products)
}

SimpleBank.prototype.revokeProduct = function (opts) {
  typeforce({
    customer: typeforce.String,
    product: typeforce.String
  }, opts)

  // return this._simulateReq(opts.customer)
  const customerHash = opts.customer
  const productPermalink = opts.product
  return this._simulateReq(opts)
    .then(updatedOpts => {
      opts = updatedOpts
      return this._revokeProduct(opts)
    })
    .then(() => this.bank._setCustomerState(opts.req))
    .finally(() => this._endRequest(opts))
}

SimpleBank.prototype.shareContext = function (req, res) {
  // TODO:
  // need to check whether this context is theirs to share

  const isEmployee = this._employees.some(e => e[ROOT_HASH] === req.from.permalink)
  if (isEmployee && req.state.relationshipManager !== req.from.permalink) {
    return utils.rejectWithHttpError(403, new Error('employee is not authorized to share this context'))
  }

  const props = req.payload.object
  const context = utils.parseObjectId(props.context.id).permalink
  const cid = calcContextIdentifier({
    bank: this,
    context: context,
    participants: [this.tim.permalink, req.customer],
  })

  if (!cid) {
    return utils.rejectWithHttpError(400, new Error('invalid context'))
  }

  const recipients = props.with.map(r => {
    return utils.parseObjectId(r.id).permalink
  })

  const method = props.revoked ? 'unshareContext' : 'shareContext'
  const action = Actions[method](context, recipients)
  req.state = getNextState(req.state, action)

  let customerIdentityInfo = req.customerIdentityInfo
  const customerProfile = req.state.profile
  const shareMethod = props.revoked ? 'unshare' : 'share'
  const shareWithOne = recipient => {
    const intro = props.revoked ? Q.resolve() : introduceCustomerTo(recipient)
    return intro.then(() => doShareWith(recipient))
  }

  const introduceCustomerTo = recipient => {
    return this.tim.signAndSend({
      to: { permalink: recipient },
      object: {
        [TYPE]: 'tradle.Introduction',
        profile: customerProfile,
        message: 'introducing...',
        identity: customerIdentityInfo.object
      }
    })
  }

  const doShareWith = recipient => {
    // console.log('sharing context: ' + calcContextIdentifier(context, this.tim.permalink, req.customer))
    return this._ctxDB[shareMethod]({
      context: cid,
      recipient,
      seq: props.seq || 0
    })
  }

  const getCustomerIdentityInfo = customerIdentityInfo && customerIdentityInfo.object
    ? Q(customerIdentityInfo)
    : this.tim.lookupIdentity({ permalink: req.customer })

  return getCustomerIdentityInfo
    .then(identityInfo => {
      customerIdentityInfo = identityInfo
      return Q.all(recipients.map(shareWithOne))
    })
}

SimpleBank.prototype._handleSharedMessage = function (req) {
  // const embeddedMsgAuthor = req.payload.author.permalink
  // const embeddedMsgRecipient = req.payload.recipient.permalink
  // return Q.allSettled([
  //   this.getCustomerState(embeddedMsgAuthor),
  //   this.getCustomerState(embeddedMsgRecipient)
  // ])
  // .then(results => {
  //   const match = results.filter(r => r.state === 'fulfilled')[0]
  //   if (!match) return console.log('NO MATCH')

  //   const customer = match.value
  //   const rm = customer.relationshipManager
  //   if (!rm) return console.log('NO RELATIONSHIP MANAGER', req.payload.object.object[TYPE])

  //   console.log('YES RELATIONSHIP MANAGER')
  //   this.tim.send({
  //     to: { permalink: rm },
  //     link: req.payload.link
  //   })
  //   .done()
  // })
}

// SimpleBank.prototype.unshareContext = function (req, res) {
//   const shareContext = req.payload.object
//   const recipients = shareContext.recipients
//   const action = Actions.unshareContext(shareContext.context, shareContext.recipients)
//   req.state = getNextState(req.state, action)
// }

SimpleBank.prototype.models = function () {
  return this.models
}

SimpleBank.prototype.getCustomerState = function (customerHash) {
  return this.bank._getCustomerState(customerHash)
}

SimpleBank.prototype._revokeProduct = function (opts) {
  // TODO: minimize code repeat with sendNextFormOrApprove
  const req = opts.req
  const newState = getNextState(req.state, Actions.revokeProduct(opts.product))
  if (newState === req.state) {
    // state didn't change
    throw new Error('product not found')
  }

  req.state = newState
  let isEmployeePass
  return this.tim.objects.get(opts.product)
    .then(wrapper => {
      // revoke product and send
      const product = wrapper.object
      delete product.message
      delete product[SIG]
      product.revoked = true
      product[PREVLINK] = wrapper.link
      product[PERMALINK] = wrapper.permalink
      isEmployeePass = product[TYPE] === 'tradle.MyEmployeeOnboarding'
      return this.send({
        req: req,
        msg: product
      })
    })
    .then(result => {
      if (isEmployeePass) {
        this._ensureEmployees()
      }

      return result
    })
}

SimpleBank.prototype._approveProduct = function ({ req, application }) {
  // TODO: minimize code repeat with sendNextFormOrApprove
  const appLink = req.context
  const productType = application.type
  let state = req.state

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
  req.state = state = getNextState(state, Actions.approveProduct(appLink))
  const confirmation = this._newProductConfirmation(state, application)

  return this.send({
    req: req,
    msg: confirmation
  })
  .then(result => {
    if (productType === 'tradle.EmployeeOnboarding') {
      this._ensureEmployees()
    }

    const pOfType = state.products[productType]
    req.state = state = getNextState(state, Actions.approvedProduct(appLink, productType, result.object.permalink))
    return result
  })
}

SimpleBank.prototype._newProductRevocation = function (opts) {
  return {
    [TYPE]: 'tradle.ProductRevocation',
    product: opts.product,
    customer: opts.customer
  }
}

SimpleBank.prototype._newProductConfirmation = function (state, application) {
  const productType = application.type
  const productModel = this.models[productType]
  const forms = application.forms

  /**
   * Heuristic:
   * Copy all properties from forms to confirmation object
   * where the property with the same name exists in both
   * the form and confirmation model
   * @param  {Object} confirmation
   * @return {Object} confirmation
   */
  const copyProperties = (confirmation, confirmationType) => {
    const confirmationModel = this.models[confirmationType]
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
  // switch (productType) {
  //   case 'tradle.LifeInsurance':
  //     confirmationType = 'tradle.MyLifeInsurance'
  //     copyProperties(confirmation, confirmationType)
  //     mutableExtend(confirmation, {
  //       [TYPE]: confirmationType,
  //       policyNumber: utils.randomDecimalString(10), // 10 chars long
  //     })

  //     return confirmation
  //   case 'tradle.Mortgage':
  //   case 'tradle.MortgageProduct':
  //     confirmationType = 'tradle.MyMortgage'
  //     copyProperties(confirmation, confirmationType)
  //     mutableExtend(confirmation, {
  //       [TYPE]: confirmationType,
  //       mortgageNumber: utils.randomDecimalString(10),
  //     })

  //     return confirmation
  //   case 'tradle.EmployeeOnboarding':
  //     confirmationType = 'tradle.MyEmployeePass'
  //     copyProperties(confirmation, confirmationType)
  //     mutableExtend(confirmation, {
  //       [TYPE]: confirmationType,
  //       employeeID: utils.randomDecimalString(10),
  //     })
  //     return confirmation
  //   default:
    const guessedMyProductModel = this.models[productType.replace('.', '.My')]
    if (guessedMyProductModel && guessedMyProductModel.subClassOf === 'tradle.MyProduct') {
      confirmation[TYPE] = confirmationType = guessedMyProductModel.id
      copyProperties(confirmation, confirmationType)
      mutableExtend(confirmation, {
        [TYPE]: confirmationType,
        myProductId: utils.randomDecimalString(10),
      })
      return confirmation
    }

    confirmationType = productType + 'Confirmation'
    const formIds = utils.getFormIds(application.forms)
    return {
      [TYPE]: confirmationType,
      // message: imported
      //   ? `Imported product: ${productModel.title}`
      message: `Congratulations! You were approved for: ${productModel.title}`,
      forms: formIds,
      application: application.permalink
    }
  // }

}


SimpleBank.prototype.send = function ({ req, msg }) {
  return this.willSend({ req, msg })
    .then(() => this.bank.send({ req, msg }))
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
  const formModel = this.models[form]
  const prompt = formModel.subClassOf === 'tradle.MyProduct'
    ? 'Please share the following information' : formModel.properties.photos ?
    // isMultiEntry ? 'Please fill out this form and attach a snapshot of the original document' :
    'Please fill out this form and attach a snapshot of the original document' : 'Please fill out this form'

  const formRequest = {
    [TYPE]: 'tradle.FormRequest',
    message: prompt,
    product: productModel.id,
    form: form
  }

  return this.willRequestForm({
      state: req.state,
      application: req.application,
      form,
      // allow the developer to modify this
      formRequest
    })
    .then(() => {
      debug('requesting form', form)
      return this.send({
        req: req,
        msg: formRequest
      })
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

    return this.models.docs[product.type].indexOf(docType) !== -1
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

    return this.send({
      req: req,
      msg: employeeNotFound
    })
  }

  var resp = {
    [TYPE]: 'tradle.EmployeeInfo',
    employee: utils.pick(employeeInfo, 'pub', 'profile')
  }

  return this.send({
    req: req,
    msg: resp
  })
}

SimpleBank.prototype.handleVerification = function (req) {
  // dangerous if verification is malformed
  const appLink = req.context
  let pending = req.application
  if (!pending) {
    if (!req.product) {
      return utils.rejectWithHttpError(400, new Error(`application ${appLink} not found`))
    }

    req.state = getNextState(req.state, Actions.receivedVerification(req.payload, appLink))
    return Q.resolve()
  }

  const { link } = utils.parseObjectId(req.payload.object.document.id)
  let verifiedItem = utils.findFormState(pending.forms, link)
  if (!verifiedItem) {
    return utils.rejectWithHttpError(400, new Error('form not found'))
  }

  req.state = getNextState(req.state, Actions.receivedVerification(req.payload, appLink))

  // get updated application and form state
  pending = req.application // dynamically calc'd prop
  verifiedItem = utils.findFormState(pending.forms, link)

  const opts = {
    state: req.state,
    application: pending,
    form: verifiedItem
  }

  return this.shouldSendVerification(opts)
    .then(should => {
      return should.result && this._sendVerification({
        req: req,
        verifiedItem: {
          author: req.from,
          object: verifiedItem.form.body,
          link: verifiedItem.form.link,
          permalink: verifiedItem.form.permalink
        }
      })
    })
    .then(() => this.sendNextFormOrApprove({req}))
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
      req.state = getNextState(req.state, Actions.importSession(session, this.models))
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
        const productModel = this.models[req.productType]
        const instructionalMsg = req.productType === REMEDIATION
          ? 'Please check and correct the following data'
          : `Let's get this ${this.models[req.productType].title} Application on the road!`

        return this.send({
          req: req,
          msg: {
            [TYPE]: SIMPLE_MESSAGE,
            message: instructionalMsg
          }
        })
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

SimpleBank.prototype._shareContexts = function () {
  this._ctxDB = createContextDB({
    node: this.tim,
    db: 'contexts.db',
    getContext: val => {
      if (val.object.context) {
        // if (val.recipient === this.tim.permalink) return

        return calcContextIdentifier({
          bank: this,
          context: val.object.context,
          participants: [val.author, val.recipient]
        })
      }
    }
    // ,
    // worker: (data, cb) => {
    //   this.tim.send({
    //     to: { permalink: data.recipient },
    //     link: data.permalink
    //   }, cb)
    // }
  })
}

SimpleBank.prototype._isEmployee = function (permalink) {
  return this._employees.some(e => e[PERMALINK] === permalink)
}

SimpleBank.prototype._forwardToCustomer = function (opts={}) {
  let unwrap = opts.unwrap
  if (!unwrap) {
    unwrap = function (msg) {
      return true // msg.object.object[TYPE] === VERIFICATION
    }
  }

  // forward messages based on forward property
  this._forwardDB = createContextDB({
    node: this.tim,
    db: 'forward.db',
    getContext: val => {
      // only forward messages from employees
      if (val.object.forward && this._isEmployee(val.author)) {
        return getContextForEmployeeToCustomerChat({
          from: val.author,
          to: this.tim.permalink,
          forward: val.object.forward
        })
      }
    },
    worker: (data, cb) => {
      this.tim.objects.get(data.link, (err, msg) => {
        if (err) return cb(err)

        const { context, object } = msg.object
        const other = {}
        if (context) other.context = context

        if (unwrap(msg)) {
          this.tim.signAndSend({
            object: tradleUtils.omit(object, SIG),
            to: { permalink: data.recipient },
            other: other
          }, cb)
        } else {
          this.tim.send({
            link: data.link,
            to: { permalink: data.recipient }
          }, cb)
        }
      })
    }
  })
}

SimpleBank.prototype._forwardToRelationshipManager = function (opts={}) {
  let unwrap = opts.unwrap
  if (!unwrap) {
    unwrap = function (msg) {
      return true // msg.object.object[TYPE] === VERIFICATION
    }
  }

  this._forwardToRMDB = createContextDB({
    node: this.tim,
    db: 'forwardToRM.db',
    getContext: val => {
      const type = val.objectinfo.type
      if (type === IDENTITY_PUBLISH_REQUEST
          || type === SELF_INTRODUCTION
          // || type === 'tradle.Message'
          || type === 'tradle.ShareContext'
      ) {
        return
      }

      return getConversationIdentifier(val.author, val.recipient)
    },
    worker: (data, cb) => {
      this.tim.objects.get(data.link, (err, msg) => {
        if (err) return cb(err)

        const { context, object } = msg.object
        const other = {}
        if (context) other.context = context

        if (unwrap(msg)) {
          // console.log(object)
          // console.log('forwarding', object[TYPE], 'to RM', data.recipient)
          this.tim.send({
            object: object,
            to: { permalink: data.recipient },
            other: other
          }, cb)
        } else {
          this.tim.send({
            link: data.link,
            to: { permalink: data.recipient }
          }, cb)
        }
      })
    }
  })
}

// PLUGIN RELATED METHODS

SimpleBank.prototype.disableDefaultPlugin = function (method) {
  const idx = this._plugins.indexOf(defaultPlugins[method])
  if (idx !== -1) {
    this._plugins.splice(idx, 1)
    return true
  }
}

SimpleBank.prototype.use = function (plugin) {
  this._plugins.push(plugin)
}

SimpleBank.prototype._execPlugins = function (method, args) {
  return this._plugins
    .filter(p => p[method])
    .reduce((promise, plugin) => {
      return promise.then(() => {
        return plugin[method].apply(this, args)
      })
    }, Q())
}

SimpleBank.prototype.willSend = function ({ req, msg }) {
  return this._execPlugins('willSend', arguments)
}

SimpleBank.prototype.willRequestForm = function ({ state, application, form, formRequest }) {
  return this._execPlugins('willRequestForm', arguments)
}

SimpleBank.prototype.onApplicationFormsCollected = function ({ req, state, application }) {
  return this._execPlugins('onApplicationFormsCollected', arguments)
}

SimpleBank.prototype.shouldSendVerification = function ({ state, application, form }) {
  return this._execBooleanPlugin('shouldSendVerification', arguments, true)
}

SimpleBank.prototype.shouldIssueProduct = function ({ state, application }) {
  return this._execBooleanPlugin('shouldIssueProduct', arguments, true)
}

/**
 * Execute a plugin method that (maybe) returns a boolean
 * @param  {String}           method
 * @param  {Array|Arguments}  arguments to method
 * @param  {Boolean}          fallbackValue if plugins don't return a boolean, default to this value
 * @return {Promise}
 */
SimpleBank.prototype._execBooleanPlugin = function (method, args, fallbackValue) {
  return this._plugins
    .filter(p => p[method])
    .reduce((promise, plugin) => {
      return promise.then(result => {
        if (typeof result === 'boolean') {
          return { result }
        }

        return plugin[method].apply(this, args)
      })
    }, Q())
    .then(result => {
      // if not vetoed, send
      return result == null  ? { result: fallbackValue } :
        typeof result === 'boolean' ? { result } : result
    }, err => {
      return {
        result: false,
        reason: err
      }
    })
}

SimpleBank.prototype._toggleForwarding = function ({ customer, employee, on=true }) {
  const method = on ? 'share' : 'unshare'

  // convo between employee and customer through bot
  const bot = this.tim.permalink
  const cid1 = getContextForEmployeeToCustomerChat({
    from: employee,
    to: this.tim.permalink,
    forward: customer
  })

  this._forwardDB[method]({
    context: cid1,
    recipient: customer,
    seq: 0
  })

  // convo between bot and customer
  const cid2 = getConversationIdentifier(this.tim.permalink, customer)
  this._forwardToRMDB[method]({
    context: cid2,
    recipient: employee,
    seq: 0
  })

  // const cid3 = getConversationIdentifier(customer, this.tim.permalink)
  // this._forwardToRMDB[method]({
  //   context: cid3,
  //   recipient: employee,
  //   seq: 0
  // })
}

function getType (obj) {
  if (obj[TYPE]) return obj[TYPE]
  if (!obj.id) return
  return utils.parseObjectId(obj.id).type
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

function alphabetical (a, b) {
  return a < b ? -1 : a === b ? 0 : 1
}

function getConversationIdentifier (...participants) {
  return participants.sort(alphabetical).join(':')
}

function toError (err) {
  return new Error(err.message || err)
}

function calcContextIdentifier ({ bank, context, participants }) {
  const rmIsParticipant = bank.employees()
    .some(e => participants.indexOf(e[PERMALINK]) !== -1)

  // messages from/to an employee get re-written and sent by the bank
  // this ignores the originals
  if (rmIsParticipant) return

  return context// + ':' + getConversationIdentifier(...participants)
}

function getContextForCustomerToBotChat ({ bot, customer }) {
  return bot + customer
}

function getContextForEmployeeToCustomerChat ({ from, to, forward }) {
  return getConversationIdentifier(from, to, forward)
}
