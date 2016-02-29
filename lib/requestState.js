
var Q = require('q')
var typeforce = require('typeforce')
var constants = require('@tradle/constants')
var extend = require('xtend/mutable')
var ROOT_HASH = constants.ROOT_HASH
var CUR_HASH = constants.CUR_HASH
var TYPE = constants.TYPE
var mutexify = require('mutexify')
var locks = {}

module.exports = RequestState

function RequestState (msg) {
  // customer state
  typeforce({
    from: 'Object'
  }, msg)

  this.state = null

  this.app = null
  this.msg = msg
  this.type = msg && msg[TYPE]
  this.resp = null
  this.promises = []

  var start = Q.defer()
  var customer = msg.from[ROOT_HASH] || msg.from.fingerprint

  // per customer - process one request at a time
  // to avoid state conflict resolution
  var lock = locks[customer] = locks[customer] || mutexify()
  var release

  this.end = () => {
    const ret = Q.all(this.promises)
    ret.finally(() => release())
    return ret
  }

  lock(_release => {
    release = _release
    start.resolve()
  })

  this._startPromise = start.promise

  extend(this, msg)
}

RequestState.prototype.start = function () {
  return this._startPromise
}

RequestState.prototype.promise = function (promise) {
  if (this._startPromise.inspect().state !== 'fulfilled') {
    throw new Error('not ready!')
  }

  this.promises.push(promise)
}
