
var Q = require('q')
var constants = require('@tradle/constants')
var extend = require('xtend/mutable')
var ROOT_HASH = constants.ROOT_HASH
var CUR_HASH = constants.CUR_HASH
var TYPE = constants.TYPE

module.exports = RequestState

function RequestState (msg) {
  // customer state
  this.state = null

  this.app = null
  this.msg = msg
  this.type = msg && msg[TYPE]
  this.resp = null
  this.promises = []

  extend(this, msg)
}

RequestState.prototype.promise = function (promise) {
  this.promises.push(promise)
}

RequestState.prototype.end = function () {
  return Q.all(this.promises)
}
