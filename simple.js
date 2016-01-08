
var typeforce = require('typeforce')
var Q = require('q')
var debug = require('debug')('bank:simple')
var constants = require('@tradle/constants')
var MODELS = require('@tradle/models')
var Builder = require('@tradle/chained-obj').Builder
var tutils = require('@tradle/utils')
var Identity = require('@tradle/identity').Identity
var Bank = require('./')
var utils = require('./lib/utils')
var RequestState = require('./lib/requestState')
var ROOT_HASH = constants.ROOT_HASH
var CUR_HASH = constants.CUR_HASH
var TYPE = constants.TYPE
var types = constants.TYPES
var FORGET_ME = 'tradle.ForgetMe'
var FORGOT_YOU = 'tradle.ForgotYou'
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

var noop = function () {}

module.exports = simpleBank

function simpleBank (opts) {
  var bank = new Bank(opts)
  bank.shouldChainReceivedMessage = function (msg) {
    return DOC_TYPES.indexOf(msg[TYPE]) !== -1
  }

  bank.use(function (req, res) {
    if (DOC_TYPES.indexOf(req.type) !== -1) {
      return handleDocument.call(bank, req)
    }
  })

  bank.use('tradle.GetMessage', lookupAndSend.bind(bank))
  bank.use('tradle.GetHistory', sendHistory.bind(bank))
  bank.use(FORGET_ME, forgetMe.bind(bank))
  bank.use(types.VERIFICATION, handleVerification.bind(bank))
  bank.use(types.CUSTOMER_WAITING, sendProductList.bind(bank))
  bank.use(types.SIMPLE_MESSAGE, function (req) {
    var msg = req.parsed.data.message
    if (!msg) return

    var parsed = utils.parseSimpleMsg(msg)
    if (parsed.type) {
      if (PRODUCT_TYPES.indexOf(parsed.type) !== -1) {
        req.productType = parsed.type
        return handleNewApplication.call(bank, req)
      }
    }
    else {
      return bank.send(req, {
        _t: types.REQUEST_FOR_REPRESENTATIVE,
        welcome: true,
        message: 'Switching to representative mode is not yet implemented'
      }, { chain: false })
    }
  })
  bank.use(types.REQUEST_FOR_REPRESENTATIVE, function (req) {
    // Find represntative
    return bank.send(req, {
      _t: types.SIMPLE_MESSAGE,
      welcome: true,
      // message: '[Hello! It very nice to meet you](Please choose the product)',
      message: 'The feature of switching to representative is coming soon!',
    }, { chain: false })
  })

  bank.receiveMsg = receiveMsg.bind(bank)
  return bank
}

function receiveMsg (msgBuf, senderInfo) {
  var bank = this
  var msg
  try {
    var wrapper = JSON.parse(msgBuf)
    msg = JSON.parse(new Buffer(wrapper.data, 'base64'))
  } catch (err) {}

  // if it's an identity, store it
  if (!msg) {
    return Bank.prototype.receiveMsg.apply(bank, arguments)
  }

  if (msg[TYPE] !== types.IDENTITY_PUBLISHING_REQUEST) {
    return utils.rejectWithHttpError(400, 'only ' + types.IDENTITY_PUBLISHING_REQUEST + ' plaintext messages accepted')
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

  return publishCustomerIdentity.call(bank, req)
    .then(function (_req) {
      req = _req
      return sendProductList.call(bank, req)
    })
    .then(function () {
      return req.end()
    })
}

function sendProductList (req) {
  var bank = this
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

function publishCustomerIdentity (req) {
  // TODO: verify that sig of identityPublishRequest comes from sign/update key
  // of attached identity. Need to factor this out of @tradle/verifier

  var bank = this
  var identity = req.parsed.data.identity
  var tim = bank.tim
  var rootHash
  var curHash
  var wasAlreadyPublished
  return Builder().data(identity).build()
    .then(function (buf) {
      return Q.ninvoke(tutils, 'getStorageKeyFor', buf)
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
        bank._debug('publishing customer identity', curHash)
        return publish()
      }
    })
    .then(function () {
      return req
    })

  function publish () {
    return tim.publishIdentity(identity)
      .then(function () {
        var resp = {}
        resp[TYPE] = 'tradle.IdentityPublished'
        resp.identity = curHash
        return bank.send(req, resp, { chain: false })
      })
  }
}

function handleNewApplication (req, res) {
  var bank = this

  typeforce({
    productType: 'String'
  }, req)

  var pending = req.state.pendingApplications
  var idx = pending.indexOf(req.productType)
  if (idx !== -1) pending.splice(idx, 1)

  pending.unshift(req.productType)
  return sendNextFormOrApprove.call(bank, req)
}

function handleDocument (req, res) {
  var bank = this
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
  var verification = newVerificationFor.call(bank, msg)
  var stored = {
    txId: null,
    body: verification
  }

  docState.verifications.push(stored)
  return bank.send(req, verification)
    .then(function (entries) {
      var rootHash = entries[0].toJSON()[ROOT_HASH]
      // stored[ROOT_HASH] = req[ROOT_HASH]
      stored[ROOT_HASH] = rootHash
      return sendNextFormOrApprove.call(bank, req)
    })
}

function newVerificationFor (msg) {
  var bank = this
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

  var org = bank.tim.identityJSON.organization
  if (org) {
    verification.organization = org
  }

  verification[TYPE] = types.VERIFICATION
  return verification
}

function sendNextFormOrApprove (req) {
  var bank = this
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
    debug('requesting form', next)
    resp = utils.buildSimpleMsg(
      'Please fill out this form and attach a snapshot of the original document',
      next
    )

    opts.chain = false
  } else {
    debug('approving for product', productType)
    resp = {}
    resp[TYPE] = productType + 'Confirmation'
    resp.message = 'Congratulations! You were approved for: ' + MODELS_BY_ID[productType].title
    resp.forms = []
    reqdForms.forEach(function(f) {
      var formId = state.forms[f].verifications[0].body.document.id
      var parts = formId.split('_')
      formId = parts.length === 2 ? formId : parts.splice(0, 2).join('_')
      resp.forms.push(formId)
    })

    var idx = pendingApps.indexOf(productType)
    pendingApps.splice(idx, 1)
  }

  return bank.send(req, resp, opts)
}

function lookupAndSend (req) {
  var bank = this
  var tim = bank.tim
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

function sendHistory (req) {
  var bank = this
  var senderRootHash = req.from[ROOT_HASH]
  var from = {}
  from[ROOT_HASH] = senderRootHash
  return bank.tim.history(from)
    .then(function (objs) {
      return Q.all(objs.map(function (obj) {
        return bank.send(req, obj.parsed.data, { chain: false })
      }))
    })
}

function handleVerification (req) {
  var bank = this
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

  return sendNextFormOrApprove.call(bank, req)
}

function forgetMe (req) {
  var bank = this
  return bank.forgetCustomer(req)
    .then(function () {
      var forgotYou = {}
      forgotYou[TYPE] = FORGOT_YOU
      return bank.send(req, forgotYou)
    })
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
