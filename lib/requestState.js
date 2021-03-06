
'use strict'

var Q = require('q')
var typeforce = require('typeforce')
var tradle = require('@tradle/engine')
var protocol = tradle.protocol
var tradleUtils = tradle.utils
var constants = tradle.constants
var extend = require('xtend/mutable')
var clone = require('xtend')
var utils = require('./utils')
var ROOT_HASH = constants.ROOT_HASH
var CUR_HASH = constants.CUR_HASH
var TYPE = constants.TYPE
var types = require('./types')
// var mutexify = require('mutexify')
// var locks = {}
// var COUNTER = 0

module.exports = RequestState

function RequestState (opts, objWrapper) {
  // customer state
  let author = (opts || objWrapper).author
  if (typeof author === 'string') author = { permalink: author }
  if (!author) throw new Error('expected author')

  this.state = opts && opts.state
  if (!objWrapper && opts.object) {
    objWrapper = tradleUtils.addLinks({
      object: opts.object.object
    })

    const type = objWrapper.object[TYPE]
    if (type === 'tradle.SelfIntroduction' || type === types.IDENTITY_PUBLISH_REQUEST) {
      objWrapper.author = author
    }
  }

//   tradleUtils.addLinks(objWrapper)
  this.message = opts
  this.payload = objWrapper
  if (opts) {
    this.context = opts.context || (opts && opts.object && opts.object.context)
  }

  let application
  Object.defineProperty(this, 'application', {
    set: val => application = val,
    get: () => {
      if (!application) {
        if (this.state && this.context) {
          application = utils.getApplication(this.state, this.context)
        }
      }

      return application
    }
  })

  Object.defineProperty(this, 'product', {
    get: () => {
      if (this.state && this.context) {
        return utils.getProduct(this.state, this.context)
      }
    }
  })

  // for (var w in this.wrappers) {
  //   var wrapper = this.wrappers[w]
  //   if (wrapper) {
  //     wrapper[CUR_HASH] = wrapper.link
  //     wrapper[ROOT_HASH] = wrapper.permalink
  //   }
  // }

  // this.parsed = opts.parsed || {
  //   data: objWrapper.object
  // }

  // var data = this.parsed.data
  this.app = null
  this.msg = opts
  this[TYPE] = this.type = objWrapper && objWrapper.object[TYPE]
  this.from = author
  this.customerIdentityInfo = author
  this.resp = null
  this.promises = []
  this.customer = this.from.permalink

//   if (objWrapper) {
//     this[CUR_HASH] = objWrapper.link
//     this[ROOT_HASH] = objWrapper.permalink
//   } else {
//     this[CUR_HASH] = protocol.linkString(data)
//     this[ROOT_HASH] = data[ROOT_HASH] || this[CUR_HASH]
//   }
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
