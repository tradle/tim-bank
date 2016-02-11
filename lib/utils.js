
var debug = require('debug')('bank:utils')
var Q = require('q')
var constants = require('@tradle/constants')
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
    return Q(err)
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
  }
}

function toNumber (n) {
  return Number(n)
}
