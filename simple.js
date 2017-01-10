'use strict'

const util = require('util')
const EventEmitter = require('events').EventEmitter
const crypto = require('crypto')
const typeforce = require('typeforce')
const clone = require('xtend')
const extend = require('xtend/mutable')
const Q = require('bluebird-q')
const co = Q.async
const collect = Q.denodeify(require('stream-collector'))
const deepClone = require('clone')
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
const Bank = require('./')
const utils = require('./lib/utils')
const Actions = require('./lib/actionCreators')
const find = utils.find
const RequestState = require('./lib/requestState')
const defaultPlugins = require('./lib/defaultPlugins')
const debug = require('./debug')
const {
  ROOT_HASH,
  CUR_HASH,
  SIG,
  SIGNEE,
  TYPE,
  PREVLINK,
  PERMALINK,
  TYPES
} = constants
const MESSAGE_TYPE = TYPES
const GUEST_SESSION = 'guestsession'
const {
  REMEDIATION,
  PRODUCT_APPLICATION,
  PRODUCT_LIST,
  IDENTITY,
  IDENTITY_PUBLISH_REQUEST,
  SELF_INTRODUCTION,
  GUEST_SESSION_PROOF,
  FORGET_ME,
  FORGOT_YOU,
  VERIFICATION,
  CUSTOMER_WAITING,
  SIMPLE_MESSAGE,
  NEXT_FORM_REQUEST,
  EMPLOYEE_ONBOARDING
} = require('./lib/types')

const REMEDIATION_MODEL = {
  [TYPE]: 'tradle.Model',
  id: REMEDIATION,
  subClassOf: 'tradle.FinancialProduct',
  interfaces: [MESSAGE_TYPE],
  forms: []
}

const BANK_VERSION = require('./package.json').version
const noop = function () {}
const DAY_MILLIS = 24 * 3600 * 1000

function SimpleBank (opts) {
  if (!(this instanceof SimpleBank)) {
    return new SimpleBank(opts)
  }

  tradleUtils.bindFunctions(this)
  EventEmitter.call(this)

  this._validate = opts.validate !== false
  this._auto = clone({
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
  const bank = this.bank = new Bank(opts)

  this._ready = this._ensureEmployees(opts.employees)

  // TODO: plugin-ize
  bank._shouldChainReceivedMessage = (msg) => {
    return msg[TYPE] === VERIFICATION ||
      this.models.docs.indexOf(msg[TYPE]) !== -1
  }

  // create new customer
  bank.use(req => {
    if (req.state) return

    const { customer, type, from, payload } = req
    const cInfo = {
      permalink: customer,
      identity: from.object
    }

    if (type === 'tradle.IdentityPublishRequest' || type === 'tradle.SelfIntroduction') {
      const profile = payload.object.profile
      if (profile) cInfo.profile = cInfo
    }

    req.state = newCustomerState(cInfo)
    this._onNewCustomer({ req })
    // yield self._setCustomerState(req)
  })

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
  // bank.use(GUEST_SESSION_PROOF, this.importSession)
  bank.use(FORGET_ME, this.forgetMe)
  bank.use(VERIFICATION, this._handleVerification)
  bank.use(CUSTOMER_WAITING, req => {
    if (!req.context) return this.sendProductList(req)
  })

  bank.use(PRODUCT_APPLICATION, (req) => {
    var product = req.payload.object.product
    req.productType = product
    if (product === 'tradle.Remediation') {
      return this.importSession(req)
    }

    if (this._productList.indexOf(product) === -1) {
      return this.replyNotFound(req, product)
    } else {
      return this.handleNewApplication(req)
    }
  })

  bank.use(req => {
    if (Bank.NO_FORWARDING || !this._employees.length) return

    let type = req.payload.object[TYPE]
    if (type === IDENTITY_PUBLISH_REQUEST || type === SELF_INTRODUCTION
        // || type === 'tradle.Message'
        || type === 'tradle.ShareContext'
    ) {
      return
    }

    const from = req.payload.author.permalink
    const isEmployee = this.isEmployee(from)
    if (isEmployee) return

    const relationshipManager = req.state.relationshipManager
    if (!relationshipManager) return

    const obj = req.msg.object.object
    const embeddedType = obj[TYPE] === MESSAGE_TYPE && obj.object[TYPE]
    const context = req.context
    const other = context && { context }
    type = embeddedType || req[TYPE]
    this._debug(`FORWARDING ${type} FROM ${req.customer} TO RM ${relationshipManager}`)
    this.tim.send({
      to: { permalink: relationshipManager },
      link: req.payload.link,
      // bad: this creates a duplicate message in the context
      other: other
    })
  })

  bank.use('tradle.ShareContext', this.shareContext)

  this._shareContexts()
  this._plugins = []

  // default plugins
  this.use(defaultPlugins)

  // this._forwardConversations()
}

module.exports = SimpleBank
util.inherits(SimpleBank, EventEmitter)

SimpleBank.prototype.autoverify = function (val) {
  if (typeof val === 'boolean') {
    this._auto.verify = val
  }

  return this._auto.verify
}

SimpleBank.prototype.autoprompt = function (val) {
  if (typeof val === 'boolean') {
    this._auto.prompt = val
  }

  return this._auto.prompt
}

SimpleBank.prototype.receiveMsg = co(function* (msg, senderInfo, sync) {
  if (Buffer.isBuffer(msg)) msg = tradleUtils.unserializeMessage(msg)

  yield this._ready
  yield this.willReceive(msg, senderInfo)
  const req = yield this.receivePrivateMsg(msg, senderInfo, sync)
  if (req) {
    try {
      yield this.didReceive({ req, msg: req.msg })
    } catch (err) {
      this._debug('experienced error in didReceive', err)
    }
  }

  return req
})

SimpleBank.prototype._assignRelationshipManager = function (req) {
  // assign relationship manager if none is assigned
  const from = req.payload.author.permalink
  const isEmployee = this.isEmployee(from)
  if (isEmployee) return

  let relationshipManager = req.state.relationshipManager
  const rmIsStillEmployed = this.isEmployee(relationshipManager)
  if (!rmIsStillEmployed) relationshipManager = null

  if (!Bank.NO_FORWARDING && req.state && !relationshipManager && this._employees.length) {
    // for now, just assign first employee
    const idx = Math.floor(Math.random() * this._employees.length)

    relationshipManager = req.state.relationshipManager = this._employees[idx].permalink
    // no need to wait for this to finish
    // console.log('ASSIGNED RELATIONSHIP MANAGER TO ' + req.customer)
    const intro = {
      [TYPE]: 'tradle.Introduction',
      message: 'Your new customer',
      // [TYPE]: 'tradle.Introduction',
      // relationship: 'customer',
      identity: req.from.object
    }

    if (req.state.profile) {
      intro.profile = req.state.profile
    } else {
      intro.name = 'Customer ' + utils.randomDecimalString(6)
    }

    this.tim.signAndSend({
      to: { permalink: relationshipManager },
      object: intro
    })

    // this._forwardDB.share({
    //   context: getConversationIdentifier(this.tim.permalink, req.customer),
    //   recipient: relationshipManager,
    //   seq: 0
    // })
  }
}

SimpleBank.prototype.lock = function (id, reason) {
  return this.bank.lock(id, reason)
}

SimpleBank.prototype._wrapInLock = co(function* (locker, fn) {
  const unlock = yield this.lock(locker)
  try {
    return fn()
  } finally {
    unlock()
  }
})

SimpleBank.prototype._setEmployees = function (employees) {
  this._employees = employees
  this.bank.setEmployees(employees)
}

SimpleBank.prototype.isEmployee = function (permalink) {
  return this._employees.some(e => e.permalink === permalink)
}

SimpleBank.prototype._ensureEmployees = co(function* (employees) {
  var self = this
  if (employees) {
    return this._setEmployees(employees)
  }

  const employeePasses = yield this.getMyEmployees()
  const identities = yield Q.all(employeePasses.map(e => {
    return self.tim.addressBook.byPermalink(e.object.customer)
  }))

  employees = identities.map(function (identityInfo, i) {
    const pass = employeePasses[i].object
    return {
      [PERMALINK]: pass.customer, // backwards compat
      permalink: pass.customer,
      pub: identityInfo.object,
      profile: {
        name: utils.pick(pass, 'firstName', 'lastName')
      }
      // txId: e.to.txId
    }
  })

  return this._setEmployees(employees)
})

SimpleBank.prototype._setProfile = function (req, res) {
  const profile = req.payload.object.profile
  if (profile) {
    req.state.profile = profile
  }
}

SimpleBank.prototype.getMyEmployees = co(function* () {
  const self = this
  const passes = yield collect(this.tim.objects.type('tradle.MyEmployeeOnboarding'))
  return passes.filter(e => {
  // issued by "me" (the bank bot)
    return e.author === self.tim.permalink && !e.object.revoked
  })
})

SimpleBank.prototype.receivePrivateMsg = co(function* (msg, senderInfo, sync) {
  try {
    var them = yield this.tim.addressBook.lookupIdentity(senderInfo)
  } catch (err) {
    const req = new RequestState({ author: senderInfo })
    yield this.replyNotFound(req)
    return
  }

  return yield this.bank.receiveMsg(msg, them, sync)
})

SimpleBank.prototype.replyNotFound = co(function* (req, whatWasntFound) {
  yield this.send({
    req: req,
    msg: {
      [TYPE]: 'tradle.NotFound',
      resource: whatWasntFound || req.from
    },
    public: true
  })

  return req.end()

  // public=true because not knowing their identity,
  // we don't know how to encrypt messages for them
})

SimpleBank.prototype.sendProductList = function (req) {
  if (autoResponseDisabled(req)) return

  var bank = this.bank
  var formModels = {}
  var list = this._productList
    .filter(productModelId => productModelId !== REMEDIATION && productModelId !== EMPLOYEE_ONBOARDING)
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
      [TYPE]: PRODUCT_LIST,
      welcome: true,
      // message: '[Hello! It very nice to meet you](Please choose the product)',
      message: `[${greeting}](Click for a list of products)`,
      list: list
    }
  })
}

SimpleBank.prototype.publishCustomerIdentity = co(function* (req) {
  // TODO: verify that sig of identityPublishRequest comes from sign/update key
  // of attached identity. Need to factor this out of @tradle/verifier
  var bank = this.bank
  var identity = req.payload.object.identity
  var tim = this.tim
  var curLink = protocol.linkString(identity)
  var rootHash = identity[ROOT_HASH] || curLink
  try {
    const obj = yield tim.objects.get(curLink)
    // if obj is queued to be chained
    // assume it's on its way to be published
    if (obj && 'sealstatus' in obj) {
      // may not be published yet, but def queued
      return bank.send({
        req: req,
        msg: utils.buildSimpleMsg('already published', IDENTITY)
      })
    }
  } catch (err) {
  }

  if (!Bank.ALLOW_CHAINING) {
    if (process.env.NODE_ENV === 'test') return notifyPublished()

    this._debug('not chaining identity. To enable chaining, set Bank.ALLOW_CHAINING=true', curLink)
    return
  }

  this._debug('sealing customer identity with rootHash: ' + curLink)
  yield tim.seal({ link: curLink })
  const resp = {
    [TYPE]: 'tradle.IdentityPublished',
    identity: curLink
  }

  return bank.send({
    req: req,
    msg: resp
  })
})

SimpleBank.prototype.handleNewApplication = co(function* (req, res) {
  typeforce({
    productType: 'String'
  }, req)

  const { productType } = req
  if (productType === REMEDIATION) return

  const pendingApp = find(req.state.pendingApplications || [], app => app.type === productType)
  if (pendingApp) {
    req.context = pendingApp.permalink
    return this.continueProductApplication({req})
  }

  const permalink = req.payload.permalink
  req.state.pendingApplications.push(newApplicationState(productType, permalink))
  req.context = permalink
  return this.continueProductApplication({req})
})

SimpleBank.prototype.handleDocument = co(function* (req, res) {
  const appLink = req.context
  const application = req.application
  if (!application || application.isProduct) {
    // TODO: save in prefilled documents

    if (appLink) {
      throw utils.httpError(400, `application ${appLink} not found`)
    }

    // was previously an object,
    // now it mimicks application.forms
    if (!Array.isArray(req.state.forms)) {
      req.state.forms = []
    }

    const formState = updateWithReceivedForm(req.state, req.payload)
    const should = yield this.shouldSendVerification({
      state: req.state,
      form: formState
    })

    if (should.result) {
      yield this._createAndSendVerification({
        req: req,
        verifiedItem: req.payload
      })
    }

    return
  }

  let state = req.state
  const next = () => this.continueProductApplication({req})
  const invalid = this.validateDocument(req)
  if (invalid) {
    req.nochain = true
    return this.requestEdit(req, invalid)
  }

  const formWrapper = req.payload
  const formState = updateWithReceivedForm(application, formWrapper)
  if (!utils.isVerifiableForm(this.models[req.type])) {
    return next()
  }

  if (!state.imported) state.imported = {}

  const imported = state.imported[req.context]
  if (imported && imported.length) {
    const current = imported.shift()
    if (!imported.length) delete state.imported[req.context]

    if (current[TYPE] === 'tradle.VerifiedItem' && utils.formsEqual(current.item, formWrapper.object)) {
      const verification = current.verification
      const sources = verification.sources
      if (sources) {
        const signed = yield Q.all(sources.map(v => {
          if (v[SIG]) {
            throw new Error('verifications can\'t be pre-signed')
          }

          return this._createVerification({
            req,
            verifiedItem: req.payload,
            verification: v
          })
        }))

        verification.sources = signed.map(v => v.object)
      }

      yield this._createAndSendVerification({
        req,
        verifiedItem: req.payload,
        verification: current.verification
      })

      return this.continueProductApplication({ req })
    }
  }

  const should = yield this.shouldSendVerification({
    state,
    application: application,
    form: formState
  })

  if (should.result) {
    yield this._createAndSendVerification({
      req: req,
      verifiedItem: formWrapper
    })
  }

  return next()
})

SimpleBank.prototype.onNextFormRequest = function (req, res) {
  const models = this.models
  const formToSkip = req.payload.object.after
  const application = find(req.state.pendingApplications, application => {
    const model = models[application.type]
    const forms = utils.getForms(model)
    return forms.indexOf(formToSkip) !== -1
  })

  if (!application || application.skip.indexOf(formToSkip) !== -1) return

  application.skip.push(formToSkip)
  return this.continueProductApplication({req})
}

SimpleBank.prototype.validateDocument = function (req) {
  const doc = req.payload.object
  const type = doc[TYPE]
  const model = this.models[type]
  if (!model) throw utils.httpError(400, `unknown type ${type}`)

  let err
  if (this._validate) {
    err = utils.validateResource(doc, model)
  }

  if (!err) {
    if (!doc[SIG]) {
      err = {
        message: 'Please review',
        errors: []
      }
    }
  }

  return err
}

SimpleBank.prototype._createAndSendVerification = co(function* (opts) {
  const { req, verifiedItem } = opts
  const { link } = yield this._createVerification(opts)
  return this._sendVerification({ req, link })
})

SimpleBank.prototype._createVerification = co(function* (opts) {
  typeforce({
    req: 'RequestState',
    verifiedItem: typeforce.Object,
    verification: typeforce.maybe(typeforce.Object)
  }, opts)

  const { req, verifiedItem } = opts
  const appLink = req.context
  const pending = req.application
  const product = req.product
  const application = appLink ? pending || product : req.state // productless forms in req.state.forms
  if (!findFormState(application.forms, verifiedItem )) {
    throw utils.httpError(400, 'form not found, refusing to send verification')
  }

  const identityInfo = this.tim.identityInfo
  const form = findFormState(application.forms, verifiedItem)
  const verification = yield this.tim.createObject({
    object: newVerificationFor({
      state: req.state,
      form,
      identity: identityInfo.object,
      verification: opts.verification
    })
  })

  verification.body = verification.object
  const verifications = form.issuedVerifications || []
  verifications.push(verification)
  form.issuedVerifications = verifications

  // run async, don't wait
  this.tim.seal({ link: verification.link })

  return verification
})

SimpleBank.prototype._sendVerification = co(function* (opts) {
  typeforce({
    req: typeforce.Object,
    link: typeforce.String
  }, opts)

  const { req, link } = opts
  const verification = findVerification(req.state, link)
  if (!verification) throw utils.httpError(400, `verification ${link} not found`)

  return this.send({
    req: req,
    msg: verification.object
  })
})

SimpleBank.prototype.sendVerification = co(function* (opts) {
  typeforce({
    verifiedItem: typeforce.oneOf('String', 'Object'),
    application: typeforce.String
  }, opts)

  const lookup = typeof opts.verifiedItem === 'string'
    ? this.tim.objects.get(opts.verifiedItem)
    : opts.verifiedItem

  let customer
  let verifiedItem = yield lookup
  if (typeof verifiedItem.author === 'string') {
    verifiedItem.author = { permalink: verifiedItem.author }
  }

  const req = new RequestState(null, verifiedItem)
  req.context = opts.application
  customer = verifiedItem.author.permalink
  const unlock = yield this.lock(customer)
  try {
    const state = req.state = yield this.getCustomerState(customer)
    const verification = yield this._createAndSendVerification({ req, verifiedItem })
    yield this.bank._setCustomerState(req)
    return verification
  } finally {
    try {
      yield req.end()
    } finally {
      unlock()
    }
  }
})

SimpleBank.prototype.requestEdit = function (req, errs) {
  typeforce({
    message: 'String',
    errors: '?Array'
  }, errs)

  const prefill = deepClone(req.payload.object)
  if (prefill) {
    // clean prefilled data
    for (let p in prefill) {
      if (p[0] === '_' && p !== TYPE) {
        delete prefill[p]
      }
    }
  }

  let message = errs.message
  const productType = req.productType || req.application.type
  if (productType === REMEDIATION) {
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

SimpleBank.prototype.continueProductApplication = co(function* (opts) {
  if (!(this._auto.prompt || this._auto.verify)) return

  typeforce({
    state: '?Object',
    req: '?RequestState',
    productType: '?String',
    application: '?String',
    noNextForm: '?Boolean'
  }, opts)

  const req = opts.req
  if (autoResponseDisabled(req)) return

  let state = (req || opts).state
  const context = opts.application || req.context
  const application = utils.getApplication(state, context)
  if (!application) {
    this._debug(`pending application ${context} not found`)
    return
  }

  const productType = application.type
  const isRemediation = productType === REMEDIATION
  const productModel = isRemediation ? REMEDIATION_MODEL : this.models[productType]
  if (!productModel) {
    throw utils.httpError(400, 'no such product model: ' + productType)
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

  if (req.type === VERIFICATION) return

  if (isRemediation) {
    const session = state.imported[req.context]
    if (session && session.length) {
      const next = session[0]
      const form = next[TYPE] === 'tradle.VerifiedItem' ? next.item : next
      const docReq = new RequestState({
        [TYPE]: form[TYPE],
        context: context,
        state: state,
        author: req.from,
        to: req.to,
        sync: req.sync,
        customer: req.customer,
        productType: REMEDIATION,
        // parsed: {
        //   data: prefilled.form
        // }
      }, { object: form })

      // TODO: figure out how to continue on req
      docReq.promise = req.promise.bind(req)
      return this.handleDocument(docReq)
    } else {
      const msg = utils.buildSimpleMsg(
        'Thank you for confirming your information with us!'
      )

      this._debug('finished remediation')
      return this.send({
        req: req,
        msg: msg
      })
    }
  }

  const isFormOrVerification = req[TYPE] === VERIFICATION || this.models.docs.indexOf(req[TYPE]) !== -1
  const reqdForms = utils.getForms(productModel)

  const multiEntryForms = productModel.multiEntryForms || []
  const missing = find(reqdForms, type => {
    if (multiEntryForms.indexOf(type) !== -1) {
      return application.skip.indexOf(type) === -1
    }

    if (find(application.forms, form => form.type === type)) {
      return
    }

    // find and use recent if available
    const recent = utils.findFilledForm(state, type)
    if (recent && recent.state) {
      if (Date.now() - recent.state.dateReceived < DAY_MILLIS) {
        // TODO: stop using 'body' and just use the wrapper that comes
        // from @tradle/engine
        updateWithReceivedForm(application, deepClone(recent.state.form))
        return
      }
    }

    // no form found
    return true
  })

  if (missing) {
    if (!this._auto.prompt || opts.noNextForm) return

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

  if (!this._auto.verify || productType === EMPLOYEE_ONBOARDING) {
    // 'application' event ugly side-effect
    if (req.continue) {
      yield req.continue
    }

    return this.onApplicationFormsCollected({ req, application })
  }

  const should = yield this.shouldIssueProduct({ state: req.state, application })
  if (should.result) {
    return this._approveProduct({
      application: application,
      req: req
    })
  }
})

SimpleBank.prototype._simulateReq = co(function* (opts) {
  const customerHash = opts.customer
  const unlock = yield this.lock(customerHash)
  const state = yield this.getCustomerState(customerHash)
  const req = new RequestState({
    state: state,
    author: {
      permalink: customerHash
    }
  })

  req.unlock = unlock
  return clone(opts, { req })
})

SimpleBank.prototype._endRequest = co(function* (req) {
  try {
    yield req.end()
  } catch (err) {
    this._debug('request ended badly', err)
  } finally {
    if (req.unlock) req.unlock()
  }
})

SimpleBank.prototype.approveProduct = co(function* (opts) {
  typeforce({
    customer: typeforce.String,
    productType: typeforce.maybe(typeforce.String),
    application: typeforce.maybe(typeforce.String)
  }, opts)

  // return this._simulateReq(opts.customer)

  const updatedOpts = yield this._simulateReq(opts)
  const req = updatedOpts.req
  try {
    let appLink = opts.application
    let application = appLink && utils.getApplication(req.state, appLink)
    if (!application) {
      application = find(req.state.pendingApplications || [], app => app.type === opts.productType)
      if (!application) {
        throw utils.httpError(400, `pending application ${appLink} not found`)
      } else {
        appLink = application.permalink
      }
    }

    req.context = appLink
    const result = yield this._approveProduct({ req, application })
    yield this.bank._setCustomerState(req)
    return result
  } catch (err) {
    this._debug('approveProduct failed', err)
    throw err
  } finally {
    this._endRequest(req)
  }
})

SimpleBank.prototype.getProducts = function (opts) {
  typeforce({
    customer: typeforce.String,
  }, opts)

  return this.getCustomerState(opts.customer)
    .then(state => state.products)
}

SimpleBank.prototype.revokeProduct = co(function* (opts) {
  typeforce({
    customer: typeforce.String,
    product: typeforce.String
  }, opts)

  // return this._simulateReq(opts.customer)
  const customerHash = opts.customer
  const productPermalink = opts.product
  opts = yield this._simulateReq(opts)
  const req = opts.req
  try {
    yield this._revokeProduct(opts)
    yield this.bank._setCustomerState(opts.req)
  } finally {
    this._endRequest(req)
  }
})

SimpleBank.prototype.shareContext = co(function* (req, res) {
  // TODO:
  // need to check whether this context is theirs to share
  const self = this
  const from = req.from.permalink
  const isEmployee = this.isEmployee(from)
  if (isEmployee && req.state.relationshipManager !== from) {
    throw utils.httpError(403, 'employee is not authorized to share this context')
  }

  const props = req.payload.object
  const context = utils.parseObjectId(props.context.id).permalink
  const cid = calcContextIdentifier({
    bank: this,
    context: context,
    participants: [this.tim.permalink, req.customer],
  })

  if (!cid) {
    throw utils.httpError(400, 'invalid context')
  }

  const recipients = props.with.map(r => {
    return utils.parseObjectId(r.id).permalink
  })

  // update context state
  if (!req.state.contexts[context]) {
    req.state.contexts[context] = { observers: [] }
  }

  const contextState = req.state.contexts[context]
  let observers = contextState.observers.filter(o => recipients.indexOf(o) === -1)
  if (!props.revoked) {
    observers = observers.concat(recipients)
  }

  contextState.observers = observers
  // end update context state

  let customerIdentityInfo = req.customerIdentityInfo
  const customerProfile = req.state.profile
  const shareMethod = props.revoked ? 'unshare' : 'share'

  if (!(customerIdentityInfo && customerIdentityInfo.object)) {
    customerIdentityInfo = yield this.tim.lookupIdentity({ permalink: req.customer })
  }

  return Q.all(recipients.map(co(function* (recipient) {
    if (!props.revoked) {
      const intro = {
        [TYPE]: 'tradle.Introduction',
        message: 'introducing...',
        identity: customerIdentityInfo.object
      }

      if (customerProfile) intro.profile = customerProfile

      yield self.tim.signAndSend({
        to: { permalink: recipient },
        object: intro
      })
    }

    return self._ctxDB[shareMethod]({
      context: cid,
      recipient,
      seq: props.seq || 0
    })
  })))
})

SimpleBank.prototype.getCustomerState = function (customerHash) {
  return this.bank._getCustomerState(customerHash)
}

SimpleBank.prototype.getCustomerWithApplication = function (applicationHash) {
  return this.bank._getCustomerForContext(applicationHash)
    .then(this.getCustomerState)
}

SimpleBank.prototype._revokeProduct = co(function* (opts) {
  // TODO: minimize code repeat with continueProductApplication
  const req = opts.req
  const productPermalink = opts.product
  const products = req.state.products
  let product
  find(Object.keys(products), type => {
    return product = find(products[type], application => application.product === productPermalink)
  })

  if (!product) {
    // state didn't change
    throw utils.httpError(400, 'product not found')
  }

  product.revoked = true

  const wrapper = yield this.tim.objects.get(opts.product)
  // revoke product and send
  const productObj = wrapper.object
  delete productObj.message
  delete productObj[SIG]
  productObj.revoked = true
  productObj[PREVLINK] = wrapper.link
  productObj[PERMALINK] = wrapper.permalink
  const result = yield this.send({
    req: req,
    msg: productObj
  })

  if (product.type === EMPLOYEE_ONBOARDING) {
    this._ensureEmployees()
  }

  return result
})

SimpleBank.prototype._approveProduct = co(function* ({ req, application }) {
  // TODO: minimize code repeat with continueProductApplication
  const productType = application.type
  const state = req.state

  this._debug('approving for product', productType)
  if (!state.products[productType]) {
    state.products[productType] = []
  }

  const products = state.products[productType]
  products.push(application)
  state.pendingApplications = state.pendingApplications.filter(app => app !== application)
  const confirmation = this._newProductConfirmation(state, application)

  const result = yield this.send({
    req: req,
    msg: confirmation
  })

  application.product = result.object.permalink
  if (productType === EMPLOYEE_ONBOARDING) {
    this._ensureEmployees()
  }

  return result
})

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

  const confirmation = {
    customer: state.permalink
  }

  let confirmationType
  const guessedMyProductModel = this.models[productType.replace('.', '.My')]
    if (guessedMyProductModel && guessedMyProductModel.subClassOf === 'tradle.MyProduct') {
      confirmation[TYPE] = confirmationType = guessedMyProductModel.id
      copyProperties(confirmation, confirmationType)
      extend(confirmation, {
        [TYPE]: confirmationType,
        myProductId: utils.randomDecimalString(10),
      })

      if (productType === EMPLOYEE_ONBOARDING && !confirmation.firstName && confirmation.lastName) {
        if (state.profile) {
          extend(confirmation, utils.pick(state.profile, 'firstName', 'lastName'))
        }
      }

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

SimpleBank.prototype.send = co(function* ({ req, msg }) {
  yield this.willSend({ req, msg })
  const ret = yield this.bank.send({ req, msg })
  yield this.didSend({ req, msg: ret.message })
  return ret
})

SimpleBank.prototype.requestForm = co(function* (opts) {
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

  const prompt = formModel.formRequestMessage ||
                 (formModel.subClassOf === 'tradle.MyProduct'
                   ? 'Please share the following information'
                   : formModel.properties.photos
                      //  isMultiEntry ? 'Please fill out this form and attach a snapshot of the original document' :
                     ? 'Please fill out this form and attach a snapshot of the original document'
                     : 'Please fill out this form')


  // const prompt = formModel.subClassOf === 'tradle.MyProduct'
  //   ? 'Please share the following information' : formModel.properties.photos ?
  //   // isMultiEntry ? 'Please fill out this form and attach a snapshot of the original document' :
  //   'Please fill out this form and attach a snapshot of the original document' : 'Please fill out this form'

  const formRequest = {
    [TYPE]: 'tradle.FormRequest',
    message: prompt,
    product: productModel.id,
    form: form
  }

  yield this.willRequestForm({
    state: req.state,
    application: req.application,
    form,
    // allow the developer to modify this
    formRequest
  })

  debug('requesting form', form)
  return this.send({
    req: req,
    msg: formRequest
  })
})

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

/**
 * Artificially receive a verification (as opposed to one being sent by the customer in a message)
 */
SimpleBank.prototype.receiveVerification = co(function* (opts) {
  let { customer, verification, req } = opts
  if (!req) {
    const sim = yield this._simulateReq({ customer })
    req = sim.req
  }

  const verifiedItemInfo = utils.parseObjectId(verification.document.id)
  const application = getAllApplications(req.state).find(application => {
    return findFormState(application.forms, verifiedItemInfo)
  })

  if (!application) {
    throw utils.httpError(400, `application not found for verification ${verification}`)
  }

  try {
    const getSaved = this.tim.objects.get(tradleUtils.hexLink(verification))
    const doSave = this.tim.saveObject({ object: verification })
    let saved
    try {
      saved = yield getSaved
    } catch (err) {
    }

    if (!saved) saved = yield doSave

    req.context = application.permalink
    req.payload = saved
    req.payload.author = { permalink: saved.author }
    const ret = yield this._handleVerification(req, { noNextForm: true })
    yield this.bank._setCustomerState(req)
    return ret
  } catch (err) {
    this._debug('failed to receive verification', err)
    throw err
  } finally {
    if (!opts.req) this._endRequest(req)
  }
})

SimpleBank.prototype._handleVerification = co(function* (req, opts={}) {
  // dangerous if verification is malformed
  const appLink = req.context
  const pending = req.application
  const product = req.product
  const application = pending || product
  if (!application) {
    throw utils.httpError(400, `application ${appLink} not found`)
  }

  const verification = req.payload
  const isByEmployee = this.isEmployee(verification.author.permalink)
  if (isByEmployee) {
    verification = yield this.tim.createObject({
      object: utils.omit(verification.object, SIG)
    })

    verification.author = {
      link: this.tim.link,
      permalink: this.tim.permalink
    }
  }

  const verifiedItemInfo = utils.parseObjectId(verification.object.document.id)
  const verifiedItem = findFormState(application.forms, verifiedItemInfo)
  if (!verifiedItem) {
    throw utils.httpError(400, 'form not found')
  }

  verification.body = verification.object // backwards compat
  verifiedItem.verifications.push(verification)

  const should = yield this.shouldSendVerification({
    state: req.state,
    application: application,
    form: verifiedItem
  })

  if (should.result) {
    yield this._createAndSendVerification({
      req: req,
      verifiedItem: extend({
        author: req.from
      }, verifiedItem.form)
    })
  }

  yield this.continueProductApplication(clone({ req }, opts))
  return verification
})

SimpleBank.prototype.forgetMe = co(function* (req) {
  const version = req.state.bankVersion
  // clear customer slate
  req.state = newCustomerState(req.state)
  req.state.bankVersion = version // preserve version
  yield this.tim.forget(req.from.permalink)

  const forgotYou = {}
  forgotYou[TYPE] = FORGOT_YOU
  return this.send({
    req: req,
    msg: forgotYou
  })
})

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

SimpleBank.prototype.importSession = co(function* (req) {
  const sessionId = req.payload.object.session
  const session = yield this.bank._getResource(GUEST_SESSION, sessionId)
  const state = req.state
  if (!state.imported) state.imported = {}

  if (!state.imported[sessionId]) {
    const permalink = req.payload.permalink
    state.imported[sessionId] = permalink
    state.imported[permalink] = session
    state.pendingApplications.push(newApplicationState(REMEDIATION, permalink))
  }

  req.context = state.imported[sessionId]
  return this.continueProductApplication({ req })
})

// SimpleBank.prototype.importSession = co(function* (req) {
//   const hash = req.payload.object.session
//   const state = req.state
//   const session = yield this.bank._getResource(GUEST_SESSION, hash)
//   const models = this.models
//   const prefilledForms = state.prefilled
//   const hasUnknownType = find(session, data => {
//     return !models[data[TYPE]]
//   })

//   if (hasUnknownType) {
//     throw utils.httpError(400, `unknown type ${hasUnknownType[TYPE]}`)
//   }

//   const forms = session.filter(data => {
//     return models[data[TYPE]].subClassOf === 'tradle.Form'
//   })

//   forms.forEach(data => {
//     prefilledForms[data[TYPE]] = {
//       form: data
//     }
//   })

//   const verifications = session.filter(data => data[TYPE] === VERIFICATION)
//   verifications.forEach(verification => {
//     const type = verification.document[TYPE]
//     const prefilled = prefilledForms[type]
//     if (prefilled) {
//       prefilled.verification = verification
//     }
//   })

//   // save now just in case
//   this.bank._setCustomerState(req)
//   // async, no need to wait for this
//   // this.bank._delResource(GUEST_SESSION, hash)

//   const applications = session.map(data => {
//     if (data[TYPE] !== SIMPLE_MESSAGE) return

//     const productType = utils.parseSimpleMsg(data.message).type
//     if (productType && this._productList.indexOf(productType) !== -1) {
//       return productType
//     }
//   })
//   .filter(obj => obj) // filter out nulls}

//   if (applications.length) {
//     // TODO: queue up all the products
//     const productType = applications[0]
//     const productModel = this.models[productType]
//     if (req.productType !== REMEDIATION) {
//     // const instructionalMsg = req.productType === REMEDIATION
//     //   ? 'Please check and correct the following data'
//     //   : `Let's get this ${this.models[req.productType].title} Application on the road!`

//       const instructionalMsg = `Let's get this ${this.models[req.productType].title} Application on the road!`
//       yield this.send({
//         req: req,
//         msg: {
//           [TYPE]: SIMPLE_MESSAGE,
//           message: instructionalMsg
//         }
//       })
//     }

//     return productType
//     // return this.handleNewApplication(req)
//   }

//       // else if (forms.length) {
//       //   // TODO: unhack this crap as soon as we scrap `sync`
//       //   var docReq = new RequestState({
//       //     from: senderInfo,
//       //     parsed: {
//       //       data: forms[0]
//       //     },
//       //     // data: msgBuf
//       //   })

//       //   for (var p in req) {
//       //     if (!(p in docReq)) delete req[p]
//       //   }

//       //   for (var p in docReq) {
//       //     if (typeof docReq[p] !== 'function') {
//       //       req[p] = docReq[p]
//       //     }
//       //   }

//       //   return this.handleDocument(req)
//       // }
// })

SimpleBank.prototype._shareContexts = function () {
  this._ctxDB = createContextDB({
    node: this.tim,
    db: 'contexts.db',
    getContext: val => {
      if (val.object.context) {
        return calcContextIdentifier({
          bank: this,
          context: val.object.context,
          participants: [val.author, val.recipient]
        })
      }
    }
  })
}

SimpleBank.prototype._forwardConversations = function () {
  this._forwardDB = createContextDB({
    node: this.tim,
    db: 'forward.db',
    getContext: val => {
      return getConversationIdentifier(val.author, val.object.forward || val.recipient)
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

SimpleBank.prototype._execPlugins = co(function* (method, args) {
  const plugins = this._plugins.filter(p => p[method])

  for (var i = 0; i < plugins.length; i++) {
    let ret = plugins[i][method].apply(this, args)
    if (utils.isPromise(ret)) yield ret
  }
})

SimpleBank.prototype._onNewCustomer = function ({ req }) {
  return this._execPlugins('newCustomer', arguments)
}

SimpleBank.prototype.didReceive = function ({ req, msg }) {
  return this._execPlugins('didReceive', arguments)
}

SimpleBank.prototype.willReceive = function ({ msg, senderInfo }) {
  return this._execPlugins('willReceive', arguments)
}

SimpleBank.prototype.willSend = function ({ req, msg }) {
  return this._execPlugins('willSend', arguments)
}

SimpleBank.prototype.didSend = function ({ req, msg }) {
  return this._execPlugins('didSend', arguments)
}

SimpleBank.prototype.willRequestEdit = function ({ req, state, editRequest }) {
  return this._execPlugins('willRequestEdit', arguments)
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
SimpleBank.prototype._execBooleanPlugin = co(function* (method, args, fallbackValue) {
  const plugins = this._plugins.filter(p => p[method])

  let result
  for (var i = 0; i < plugins.length; i++) {
    let plugin = plugins[i]
    let ret
    try {
      ret = plugin[method].apply(this, args)
      if (utils.isPromise(ret)) ret = yield ret
    } catch (err) {
      return {
        result: false,
        reason: err
      }
    }

    if (typeof ret === 'boolean') {
      result = { result: ret }
      break
    }
  }

  if (result == null) return { result: fallbackValue }

  return typeof result === 'boolean' ? { result } : result
})

function getType (obj) {
  if (obj[TYPE]) return obj[TYPE]
  if (!obj.id) return
  return utils.parseObjectId(obj.id).type
}

function alphabetical (a, b) {
  return a < b ? -1 : a === b ? 0 : 1
}

function getConversationIdentifier (a, b) {
  return [a, b].sort(alphabetical).join(':')
}

function calcContextIdentifier ({ bank, context, participants }) {
  const rmIsParticipant = bank.employees()
    .some(e => participants.indexOf(e.permalink) !== -1)

  // messages from/to an employee get re-written and sent by the bank
  // this ignores the originals
  if (rmIsParticipant) return

  return context// + ':' + getConversationIdentifier(...participants)
}

function findFormState (forms, formInfo) {
  // temporary solution, using lenient matching
  // to prevent simple clients from getting confused
  // when no verifications get sent/forwarded because verifications
  // are issued for older versions of forms
  //
  // obviously bad
  //
  // TODO: revert to this
  // return utils.findFormState(pending.forms, { link: formInfo.link })
  return utils.findFormStateLenient(forms, formInfo)
}

function newApplicationState (type, permalink) {
  return {
    type,
    permalink,
    skip: [],
    forms: []
  }
}

function updateWithReceivedForm (application, formWrapper) {
  const { link, permalink, object } = formWrapper
  const existing = findFormState(application.forms, { permalink })
  if (existing) {
    if (existing.link === link) return
  }

  const form = {
    link: link,
    permalink: permalink,
    // body: req.data, // raw buffer
    body: object, // backwards compat
    object: object,
    // txId: action.txId,
    time: object.time || Date.now() // deprecated
  }

  const newFormObj = {
    type: object[TYPE],
    form: form,
    dateReceived: Date.now(),
    verifications: [],
    issuedVerifications: []
  }

  if (existing) {
    extend(existing.form, form)
    existing.dateReceived = newFormObj.dateReceived
  } else {
    application.forms.push(newFormObj)
  }

  return existing || newFormObj
}

function newVerificationFor (opts) {
  const customerState = opts.state
  const formState = opts.form
  const identity = opts.identity
  const formInfo = formState.form
  const verifications = formState.verifications
  const doc = formInfo.object || formInfo.body
  const verification = opts.verification || utils.getImportedVerification(customerState, doc) || {}
  if (!verification.dateVerified) verification.dateVerified = Date.now()

  verification.document = {
    id: doc[TYPE] + '_' + formInfo.permalink + '_' + formInfo.link,
    title: doc.title || doc[TYPE]
  }

  verification.documentOwner = {
    id: IDENTITY + '_' + customerState.permalink,
    title: customerState.permalink
  }

  const org = identity.organization
  if (org) {
    verification.organization = org
  }

  verification[TYPE] = VERIFICATION
  if (verifications && verifications.length) {
    verification.sources = verifications.map(v => v.object || v.body)
  }

  return verification
}

function newCustomerState (customer) {
  return extend({
    documents: {},
    forms: [],
    pendingApplications: [],
    products: {},
    // forms: [],
    prefilled: {},
    imported: {},
    bankVersion: BANK_VERSION,
    contexts: {}
  }, tradleUtils.pick(customer, 'permalink', 'profile', 'identity'))
}

function findVerification (state, link) {
  let verification
  getAllApplications(state).find(application => {
    return application.forms.find(form => {
      return verification = form.issuedVerifications.find(v => {
        return v.link === link
      })
    })
  })

  return verification
}

function getAllApplications (state) {
  const products = Object.keys(state.products).reduce(function (all, productType) {
    return all.concat(state.products[productType])
  }, [])

  return state.pendingApplications.concat(products).concat(state)
}

function autoResponseDisabled (req) {
  const msg = req.msg && req.msg.object
  const other = msg && msg.other
  return other && other.disableAutoResponse
}
