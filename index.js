require('multiplex-utp')

var path = require('path')
var debug = require('debug')('bank')
var typeforce = require('typeforce')
var utils = require('tradle-utils')
var fs = require('fs')
// var level = require('react-native-level')
var Q = require('q')
var constants = require('tradle-constants')
var Builder = require('chained-obj').Builder
var buildNode = require('./lib/buildNode')
var CUR_HASH = constants.CUR_HASH
var ROOT_HASH = constants.CUR_HASH
var TYPE = constants.TYPE
var OWNER = constants.OWNER
var types = require('./lib/types')

module.exports = Bank

function Bank (options) {
  var self = this

  typeforce({
    identity: 'Object',
    identityKeys: 'Array',
    port: 'Number',
    networkName: 'String',
    ip: 'String',
    blockchain: '?Object',
    keeper: '?Object'
  }, options)

  utils.bindPrototypeFunctions(this)

  this._identity = options.identity
  this._keys = options.identityKeys
  this._port = options.port

  var tim = this._tim = buildNode(options)

  tim.on('error', function (err) {
    self._debug('error', err)
  })

  tim.on('message', function (info) {
    tim.lookupObject(info)
      .then(self._onmessage)
  })

  var readyDefer = Q.defer()
  this._readyPromise = readyDefer.promise

  tim.once('ready', function () {
    self._ready = true
    readyDefer.resolve()
    // printIdentityStatus(tim)
    //   .then(dumpDBs.bind(null, tim))
  })
}

Bank.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this._tim.name())
  return debug.apply(null, args)
}

Bank.prototype._onmessage = function (obj) {
  if (!this._ready) {
    return this._readyPromise.then(this._onmessage.bind(this, obj))
  }

  var msgType = obj[TYPE]
  this._debug('received message of type', msgType)

  switch (msgType) {
    case types.CurrentAccountApplication:
      return this._handleCurrentAccountApplication(obj)
    default:
      this._debug('ignoring message of type', obj[TYPE])
      break;
  }
}

Bank.prototype._handleCurrentAccountApplication = function (app) {
  var self = this
  var curHash = app[CUR_HASH]
  var data = app.parsed.data
  var resp = {
    application: curHash,
    status: 'accepted'
  }

  resp[TYPE] = types.CurrentAccountConfirmation
  resp[OWNER] = this._tim.myCurrentHash()
  typeforce('String', resp[OWNER])

  var b = Builder()
    .data(resp)
    .signWith(this._tim.signingKey)

  Q.ninvoke(b, 'build')
    .then(function (build) {
      return self._tim.send({
        to: [app.from],
        msg: build.form,
        // chain: true,
        deliver: true
      })
    })
    .done()
}

Bank.prototype.destroy = function () {
  if (this._destroyPromise) return this._destroyPromise

  return this._destroyPromise = this._tim.destroy()
}

// var keeper = fakeKeeper.empty()

// var tedPub = new Buffer(stringify(require('./fixtures/ted-pub.json')), 'binary')
// var tedPriv = require('./fixtures/ted-priv')
// var ted = Identity.fromJSON(tedPriv)
// var tedPort = 51087
// var tedWallet = realWalletFor(ted)
// var blockchain = tedWallet.blockchain
// var tedWallet = walletFor(ted)

// clear(function () {
  // print(init)
// })

// clear(init)
// init()

// ;['bill', 'ted'].forEach(function (prefix) {
//   var keeper = new Keeper({
//     storage: prefix + '-storage',
//     fallbacks: ['http://tradle.io:25667']
//   })

//   keeper.getAll()
//     .then(function (map) {
//       for (var key in map) {
//         keeper.push({
//           key: key,
//           value: map[key]
//         })
//       }
//     })
// })

// clear(function () {
//   var keeper = new Keeper({
//     storage: 'blah',
//     fallbacks: ['http://tradle.io:25667']
//   })

//   keeper.put(new Buffer('1'))
//     .then(function () {
//       return keeper.getAll()
//     })
//     .then(function (map) {
//       debugger
//       for (var key in map) {
//         keeper.push({
//           key: key,
//           value: map[key]
//         })
//       }
//     })
//     .catch(function (err) {
//       debugger
//     })
// })

// function init () {
//   setInterval(printIdentityStatus, 30000)
// }

// function onTimReady () {
//   console.log(tim.name(), 'is ready')
// }

function dumpDBs (tim) {
  var identities = tim.identities()
  identities.onLive(function () {
    identities.createValueStream()
      .on('data', function (result) {
        // console.log('identity', result.identity.name.firstName)
        console.log('identity', result.identity)
      })
  })

  var messages = tim.messages()
  messages.onLive(function () {
    messages.createValueStream()
      .on('data', function (data) {
        tim.lookupObject(data)
          .then(function (obj) {
            console.log('msg', obj[CUR_HASH])
          })
      })
  })
}

function printIdentityStatus (tim) {
  return tim.identityPublishStatus()
    .then(function (status) {
      console.log(tim.name(), 'identity publish status', status)
    })
}
