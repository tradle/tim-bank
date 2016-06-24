
var Q = require('q')
var typeforce = require('typeforce')
var constants = require('@tradle/constants')
var extend = require('xtend/mutable')
var ROOT_HASH = constants.ROOT_HASH
var CUR_HASH = constants.CUR_HASH
var TYPE = constants.TYPE
// var mutexify = require('mutexify')
// var locks = {}
// var COUNTER = 0

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
  this.customer = msg.from[ROOT_HASH]

  // var start = Q.defer()
  // var customer = msg.from[ROOT_HASH] || msg.from.fingerprint
  // var me = msg.to && msg.to[ROOT_HASH] || ('' + COUNTER++) // separate lock
  // var lockID = customer + me

  // per customer - process one request at a time
  // to avoid state conflict resolution
  // var lock = locks[lockID] = locks[lockID] || mutexify()
  // var release
  // var released

  // this.end = () => {
  //   const timeout = setTimeout(release, LOCK_TIMEOUT)
  //   const ret = Q.all(this.promises)
  //   ret.finally(() => release())
  //   return ret
  // }

  // this.abort = () => release()

  // lock(_release => {
  //   release = function () {
  //     if (!released) {
  //       released = true
  //       _release()
  //     }
  //   }

  //   start.resolve()
  // })

  // this._startPromise = start.promise

  extend(this, msg)
}

// RequestState.prototype.start = function () {
//   return this._startPromise
// }

RequestState.prototype.promise = function (promise) {
  // if (this._startPromise.inspect().state !== 'fulfilled') {
  //   throw new Error('not ready!')
  // }

  this.promises.push(promise)
}

RequestState.prototype.end = function () {
  return Q.all(this.promises)
}
