
var Q = require('q')
var constants = require('@tradle/constants')
var ROOT_HASH = constants.ROOT_HASH
var CUR_HASH = constants.CUR_HASH
var TYPE = constants.TYPE

module.exports = RequestState

function RequestState (msg) {
  this.app = null
  this.msg = msg
  this.txId = msg.txId
  this.from = msg.from[ROOT_HASH]
  this[TYPE] = msg[TYPE]
  this.type = msg[TYPE]
  this.data = msg.data
  this.parsed = msg.parsed
  this[ROOT_HASH] = msg[ROOT_HASH]
  this[CUR_HASH] = msg[CUR_HASH]
  this.state = null
  this.resp = null
  this.promises = []
}

RequestState.prototype.promise = function (promise) {
  this.promises.push(promise)
}

RequestState.prototype.end = function () {
  return Q.all(this.promises)
}
