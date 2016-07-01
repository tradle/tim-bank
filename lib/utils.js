'use strict'

var crypto = require('crypto')
var debug = require('debug')('bank:utils')
var clone = require('clone')
var extend = require('xtend')
var deepEqual = require('deep-equal')
var Q = require('q')
var protocol = require('@tradle/protocol')
var constants = protocol.constants
var CUR_HASH = constants.CUR_HASH
var SIG = constants.SIG
var SIGNEE = constants.SIGNEE
var TYPE = constants.TYPE
var BUILTIN_MODELS = require('@tradle/models')
var SIMPLE_MSG_REGEX = /^\[([^\]]+)\]\(([^\)]+)\)/
var slice = Array.prototype.slice

var utils = module.exports = {
  parseSimpleMsg: function (msg) {
    var match = msg.match(SIMPLE_MSG_REGEX)
    if (!match) return {}

    return {
      message: match[1],
      type: match[2]
    }
  },

  buildSimpleMsg: function (msg, type) {
    var sMsg = {}
    sMsg[constants.TYPE] = 'tradle.SimpleMessage'
    sMsg.message = type
      ? '[' + msg + ']' + '(' + type + ')'
      : msg

    return sMsg
  },

  waitForEvent: function (tim, event, wrapper) {
    const self = this
    const link = wrapper.link
    debug('waiting for', event, link)
    tim.on(event, handler)
    const defer = Q.defer()
    return defer.promise

    function handler (metadata) {
      if (metadata.link === link) {
        debug('done waiting for', event, link)
        tim.removeListener(event, handler)
        defer.resolve(metadata)
      }
    }
  },

  /**
   * middleware processor
   * @return {Object} middleware with `use` and `exec` functions
   */
  middles: function () {
    var middles = []
    return {
      use: function (fn) {
        middles.push(fn)
      },
      exec: function (req, res) {
        return middles.reduce(function (promise, middle) {
          return promise.then(function () {
            return middle(req, res)
          })
        }, Q())
      }
    }
  },

  rejectWithHttpError: function (code, msg) {
    var err = msg instanceof Error ? msg : new Error(msg)
    err.code = code
    return Q.reject(err)
  },

  versionGT: function (v1, v2) {
    if (typeof v1 === 'string') v1 = v1.split('.').map(toNumber)
    if (typeof v2 === 'string') v2 = v2.split('.').map(toNumber)

    for (var i = 0; i < v1.length; i++) {
      if (v1[i] < v2[i]) return false
      if (v1[i] > v2[i]) return true
    }

    return false // equal
  },

  format: function (format) {
    var args = Array.prototype.slice.call(arguments, 1)
    return format.replace(/{(\d+)}/g, function(match, number) {
      return typeof args[number] != 'undefined'
        ? args[number]
        : match
    })
  },

  pick: function (obj) {
    var picked = {}
    for (var i = 1; i < arguments.length; i++) {
      var p = arguments[i]
      picked[p] = obj[p]
    }

    return picked
  },

  omit: function (obj) {
    var omit = slice.call(arguments, 1)
    var picked = {}
    Object.keys(obj).forEach(key => {
      if (omit.indexOf(key) === -1) {
        picked[key] = obj[key]
      }
    })

    return picked
  },

  formsEqual: function formsEqual (a, b) {
    return deepEqual(utils.neuterObj(a), utils.neuterObj(b))
  },

  neuterObj: function (obj) {
    var neutered = {}
    for (var p in obj) {
      if (p !== 'from' && p !== 'to' && (p[0] !== '_' || p === TYPE)) {
        neutered[p] = obj[p]
      }
    }

    return neutered
  },

  processModels: function (models) {
    if (!models) {
      models = BUILTIN_MODELS
    } else {
      models = models
        .slice()
        .concat(BUILTIN_MODELS.filter((builtin, i) => {
          return models.every(custom => {
            return custom.id !== builtin.id
          })
        }))

      // TODO: prune unneeded models
    }

    models = models.map(model => {
      return clone(model)
    })

    // models is both array and map by id
    models.forEach(model => {
      models[model.id] = model
    })

    const products = models
      .filter(m => m.subClassOf === 'tradle.FinancialProduct')
      .map(m => m.id)

    // docs is both array and map by product id
    const docs = []
    products.forEach(productType => {
      const model = models[productType]
      const forms = utils.getForms(model)
      docs[productType] = forms
      forms.forEach(type => {
        if (docs.indexOf(type) === -1) {
          docs.push(type)
        }
      })
    })

    models.docs = docs
    models.products = products
    return models
  },

  getForms: function (model) {
    try {
      return model.forms || model.properties.forms.items
    } catch (err) {
      return []
    }
  },

  getMissingForms: function getMissingForms (state, productModel) {
    return utils.getForms(productModel)
      .filter(f => {
        const forms = state.forms.filter(form => form.type === f)
        const last = utils.last(forms)
        return !(last && last.form)
      })
  },

  getUnverifiedForms: function getUnverifiedForms (verifier, state, productModel) {
    const unverified = []
    utils.getForms(productModel).forEach(f => {
      const fState = utils.findLast(state.forms, form => form.type === f)
      const isUnverified = !fState || !fState.verifications || fState.verifications.every(v => {
        const object = v.body
        const pubKey = protocol.sigPubKey({ object }).pub.toString('hex')
        const ok = verifier.pubkeys.some(p => {
          return p.pub === pubKey
        })

        return !ok
//         return !v[SIGNEE] || v[SIGNEE].indexOf(verifierHash) === -1
      })

      if (isUnverified) {
        unverified.push({
          type: f,
          link: fState.form.link
        })
      }
    })

    return unverified
  },

  validateResource: function (resource, model) {
    // very basic validation
    return validateRequired(resource, model) || validateSig(resource, model)
  },

  randomDecimalString: function (digits) {
    let str = ''
    const bytes = crypto.randomBytes(digits)
    for (var i = 0; str.length < digits; i++) {
      str += bytes[i] * 10 / 256 | 0
    }

    return str.slice(0, digits)
  },

  find: function (arr, test) {
    for (var i = 0; i < arr.length; i++) {
      let val = arr[i]
      if (test(val)) return val
    }
  },

  findLast: function (arr, test) {
    var i = arr.length
    while (i--) {
      var val = arr[i]
      if (test(val)) return val
    }
  },

  getImportedVerification: function (state, doc) {
    const prefilled = state.prefilled && state.prefilled[doc[TYPE]]
    if (prefilled && prefilled.verification && utils.formsEqual(prefilled.form, doc)) {
      return prefilled.verification
    }
  },

  findFormState: function findFormState (forms, curHash) {
    return utils.find(forms, state => state.form.link === curHash)
  },

  findApplication: function findApplication (apps, type) {
    return utils.find(apps, app => app.type === type)
  },

  last: function (arr) {
    return arr.length && arr[arr.length - 1]
  },

  lastVerificationFor: function (forms, docHash) {
    const fState = utils.findFormState(forms, docHash)
    return utils.last(fState.verifications)
  },

  replace: function replace (arr, item, newItem) {
    const idx = arr.indexOf(item)
    if (idx === -1) throw new Error('item not in array')
    return arr.slice(0, idx).concat(newItem).concat(arr.slice(idx + 1))
  },

  promisifyNode: function (node) {
    ;['sign', 'send', 'signAndSend', 'seal', 'receive',
    'watchSeal', 'watchNextVersion', 'forget', 'addContactIdentity', 'addContact'].forEach(method => {
      var orig = node[method]
      if (orig._promisified) return orig

      node[method] = function () {
        if (typeof arguments[arguments.length - 1] === 'function') {
          return orig.apply(node, arguments)
        }

        return Q.nfapply(orig, [].slice.call(arguments))
      }

      node[method]._promisified = true
    })

    return node
  }
}

function toNumber (n) {
  return Number(n)
}

function validateRequired (resource, model) {
  const required = (model.required || Object.keys(model.properties))
    .filter(name => name[0] !== '_' && name !== 'from' && name !== 'to')

  const missing = required.filter(name => {
    // built-in props
    return name !== 'from' && name !== 'to' && resource[name] == null
  })

  if (!missing.length) return

  let msg
  if (missing.indexOf('photos') === -1) {
    msg = 'You left a required field blank. Please edit?'
  } else {
    if (model.subClassOf === 'tradle.Form') {
      msg = 'Please attach a snapshot of the supporting document'
    } else {
      msg = 'Please attach a photo'
    }
  }

  return {
    message: msg,
    errors: missing.map(name => {
      return {
        name: name,
        error: 'This field is required'
      }
    })
  }
}

function validateSig (resource, model) {
  if (!resource[SIG]) {
    return {
      message: 'Please take a second to review this data',
      errors: []
    }
  }
}
