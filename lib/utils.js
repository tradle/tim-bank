
var debug = require('debug')('bank:utils')
var clone = require('clone')
var extend = require('xtend')
var Q = require('q')
var constants = require('@tradle/constants')
var BUILTIN_MODELS = require('@tradle/models')
var SIMPLE_MSG_REGEX = /^\[([^\]]+)\]\(([^\)]+)\)/

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
    sMsg[constants.TYPE] = constants.TYPES.SIMPLE_MESSAGE
    sMsg.message = type
      ? '[' + msg + ']' + '(' + type + ')'
      : msg

    return sMsg
  },

  waitForEvent: function (tim, event, entry) {
    var self = this
    var uid = entry.get('uid')
    debug('waiting for', event, uid)
    tim.on(event, handler)
    var defer = Q.defer()
    return defer.promise

    function handler (metadata) {
      if (metadata.uid === uid) {
        debug('done waiting for', event, uid)
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
        const docState = state.forms[f]
        return !(docState && docState.form)
      })
  },

  getUnverifiedForms: function getUnverifiedForms (state, productModel) {
    return utils.getForms(productModel)
      .filter(f => {
        const docState = state.forms[f]
        return !(docState && docState.verifications.length)
      })
  }
}

function toNumber (n) {
  return Number(n)
}
