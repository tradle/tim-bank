#!/usr/bin/env node

var path = require('path')
var fs = require('fs')
var typeforce = require('typeforce')
var Q = require('q')
var debug = require('debug')('bankd')
var express = require('express')
var leveldown = require('leveldown')
var constants = require('tradle-constants')
var Bank = require('./')
var buildNode = require('./lib/buildNode')
var HttpServer = require('./lib/httpMessengerServer')
var Identity = require('tim').Identity
var installServer = require('tim-server')
var Zlorp = require('tim').Zlorp
Zlorp.ANNOUNCE_INTERVAL = 10000
Zlorp.LOOKUP_INTERVAL = 10000
var DEV = process.env.NODE_ENV === 'development'
var DEFAULT_PORT = 44444
var DEFAULT_TIM_PORT = 34343

var confPath = process.argv[2]
var conf = require(path.resolve(confPath))
if (!conf) throw new Error('specify conf file path')

var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    p: 'public'
  }
})

var express = require('express')
var server
var selfDestructing
var onDestroy = []
process.on('exit', cleanup)
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('uncaughtException', function (err) {
  console.log('Uncaught exception, caught in process catch-all: ' + err.message)
  console.log(err.stack)
})

run()

function run () {
  var app = express()
  var port = Number(conf.port) || DEFAULT_PORT
  server = app.listen(port)

  // destroy = installServer({
  //   tim: tim,
  //   app: app,
  //   public: argv.public
  // })

  Object.keys(conf.banks).forEach(function (name) {
    runBank({
      name: name,
      conf: conf.banks[name],
      app: app
    })
    .then(function () {
      console.log(name, 'is live at http://127.0.0.1:' + port + '/' + name.toLowerCase())
    })
  })

  console.log('Server running on port', port)
}

function runBank (opts) {
  typeforce({
    name: 'String',
    conf: 'Object',
    app: 'EventEmitter'
  }, opts)

  typeforce({
    pub: 'String',
    priv: 'String',
    port: '?Number'
  }, opts.conf)

  if (opts.conf.run === false) {
    return Q.reject(new Error('not running'))
  }

  var app = opts.app
  var name = opts.name.toLowerCase()
  var conf = opts.conf
  var port = conf.port || (DEFAULT_TIM_PORT++)
  var identity = loadJSON(conf.pub)
  var keys = loadJSON(conf.priv)

  var router = express.Router()
  var httpServer = new HttpServer({
    router: router
  })

  var tim = buildNode({
    port: port,
    networkName: 'testnet',
    identity: Identity.fromJSON(identity),
    identityKeys: keys,
    syncInterval: 60000,
    afterBlockTimestamp: constants.afterBlockTimestamp,
    messenger: httpServer
  })

  var bank = new Bank({
    tim: tim,
    path: conf.storage || (name + '-storage'),
    leveldown: leveldown,
    manual: true // receive msgs manually
  })

  httpServer.receive = bank.receiveMsg.bind(bank)
  tim.once('ready', function () {
    app.use('/' + name + '/send', router)
  })

  bank.wallet.balance(function (err, balance) {
    console.log(opts.name, ' Balance: ', balance)
    console.log(opts.name, ': Send coins to', bank.wallet.addressString)
  })

  app.get('/' + name + '/list/:type', function (req, res, next) {
    bank.list(req.params.type)
      .then(res.json.bind(res))
      .catch(sendErr.bind(null, res))
  })

  var timRouter = express.Router()
  app.use('/' + name, timRouter)

  installServer({
    tim: tim,
    app: timRouter,
    public: argv.public
  })

  onDestroy.push(bank.destroy)

  getIdentityPublishStatus(tim)
    .then(console.log.bind(console, opts.name))

  return tim.ready()
}

function sendErr (res, err) {
  var msg = DEV ? err.message : 'something went horribly wrong'
  res.status(500).send(err.message + '\n' + err.stack)
}

function getIdentityPublishStatus (tim) {
  return tim.identityPublishStatus()
    .then(function (status) {
      var msg = 'identity status: '
      if (status.current) msg += 'published latest'
      else if (status.queued) msg += 'queued for publishing'
      else if (!status.ever) msg += 'unpublished'
      else msg += 'published, needs republish'

      return msg
    })
    .catch(function (err) {
      console.error('failed to get identity status', err.message)
      throw err
    })
}

function cleanup () {
  if (selfDestructing || !server) return

  selfDestructing = true
  debug('cleaning up before shut down...')
  try {
    server.close()
  } catch (err) {}

  Q.all(onDestroy)
    .done(function () {
      debug('shutting down')
      process.exit()
    })
}

function loadJSON (filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath)))
}
