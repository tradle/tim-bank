
var typeforce = require('typeforce')
var Q = require('q')
var debug = require('debug')('bank:simple')
var constants = require('@tradle/constants')
var MODELS = require('@tradle/models')
var Bank = require('./')
var utils = require('./lib/utils')
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

module.exports = simpleBank

function simpleBank (opts) {
  var bank = new Bank(opts)
  bank.use(function (req, res) {
    if (DOC_TYPES.indexOf(req.type) !== -1) {
      return handleDocument.call(bank, req)
    }
  })

  bank.use('tradle.GeMessage', lookupAndSend.bind(bank))
  bank.use('tradle.GetHistory', sendHistory.bind(bank))
  bank.use(FORGET_ME, forgetMe.bind(bank))
  bank.use(types.VERIFICATION, handleVerification.bind(bank))
  bank.use(types.SIMPLE_MESSAGE, function (req) {
    var msg = req.parsed.data.message
    if (msg) {
      var parsed = utils.parseSimpleMsg(msg)
      if (PRODUCT_TYPES.indexOf(parsed.type) !== -1) {
        req.productType = parsed.type
        return handleNewApplication.call(bank, req)
      }
    }
  })

  return bank
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
    return Q.reject(new Error('unable to determine product requested'))
  }

  var productModel = MODELS_BY_ID[productType]
  if (!productModel) {
    return Q.reject(new Error('no such product model: ' + productType))
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
      'Please fill out this form and attach the snapshot of the original document',
      next
    )

    opts.chain = false
  } else {
    debug('approving for product', productType)
    resp = {}
    resp[TYPE] = productType + 'Confirmation'
    resp.message = 'Congratulations! You were approved for: ' + MODELS_BY_ID[productType].title
    var idx = pendingApps.indexOf(productType)
    pendingApps.splice(idx, 1)
  }

  return bank.send(req, resp, opts)
}

function lookupAndSend (req) {
  var bank = this
  var info = {}
  info[CUR_HASH] = req.parsed.data.hash
  return bank.tim.lookupObject(info)
    .then(function (obj) {
      return bank.send(req, obj.parsed.data, { chain: false })
    })
}

function sendHistory (req) {
  var bank = this
  var senderRootHash = req.from
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
