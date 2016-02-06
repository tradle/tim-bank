#!/usr/bin/env node

var path = require('path')
var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    h: 'help',
    s: 'seq',
    c: 'chain',
    b: 'providers',
    d: 'path', // dir
    p: 'port'
  },
  default: {
    chain: true,
    path: path.resolve('storage')
  },
  boolean: ['chain', 'seq']
})

if (argv.help) {
  printUsage()
  process.exit(0)
}

var fs = require('fs')
var mkdirp = require('mkdirp')
var typeforce = require('typeforce')
var Q = require('./q-to-bluebird')
var debug = require('debug')('bankd')
var leveldown = require('leveldown')
var constants = require('@tradle/constants')
var ROOT_HASH = constants.ROOT_HASH
var Builder = require('@tradle/chained-obj').Builder
var Bank = require('./')
Bank.ALLOW_CHAINING = argv.chain
var newSimpleBank = require('./simple')
var buildNode = require('./lib/buildNode')
var watchBalanceAndRecharge = require('./lib/rechargePeriodically')
var Tim = require('tim')
Tim.enableOptimizations()
var HttpServer = require('@tradle/transport-http').HttpServer
var WebSocketClient = require('@tradle/ws-client')
var WebSocketRelay = require('@tradle/ws-relay')
var DSA = require('@tradle/otr').DSA
var Identity = Tim.Identity
var installServer = require('@tradle/tim-server')
var localOnly = installServer.middleware.localOnly
var BlockchainProxy = require('@tradle/cb-proxy')
var Blockchain = require('@tradle/cb-blockr')
// var Zlorp = Tim.Zlorp
// Zlorp.ANNOUNCE_INTERVAL = 10000
// Zlorp.LOOKUP_INTERVAL = 10000
var DEV = process.env.NODE_ENV === 'development'
var DEFAULT_PORT = 44444
var DEFAULT_TIM_PORT = 34343
var DEFAULT_NETWORK = 'testnet'

var confPath = process.argv[2]
var conf = require(path.resolve(confPath))
if (!conf) throw new Error('specify conf file path')

var express = require('express')
var compression = require('compression')
var networkName = conf.networkName || DEFAULT_NETWORK
var afterBlockTimestamp = conf.afterBlockTimestamp ||  constants.afterBlockTimestamp
var server
var selfDestructing
var onDestroy = []

var providerNames = argv.providers
  ? argv.providers.split(',').map(function (b) {
    return b.trim()
  })
  : Object.keys(conf.providers).filter(function (name) {
    return conf.providers[name].run !== false
  })

providerNames.forEach(function (name) {
  if (!(name in conf.providers)) {
    throw new Error('no bank with name: ' + name)
  }

  var bConf = conf.providers[name]
  console.log(name, bConf.bot)
  bConf.bot = require(path.resolve(path.dirname(confPath), bConf.bot))
})

var ENDPOINT_INFO = {
  providers: providerNames.map(function (name) {
    var bConf = conf.providers[name]
    // TODO: remove `txId` when we stop using blockr
    // or when blockr removes its 200txs/address limit
    var info = pick(bConf, 'wsPort', 'org')
    info.bot = pick(bConf.bot, 'pub', 'profile', 'txId')
    return info
  })
}

// var manualTxs = [
//   // safe
//   'a605b1b60a8616a7e145834e1831d498689eb5fc212d1e8c11c45a27ea59b5f8',
//   // easy
//   '0080491d1b9d870c6dcc8a60f87fa0ba1fcc617f76e8f414ecb1dd86188367a9',
//   // europi
//   '90c357e9f37a95d849677f6048838bc70a6694829c30988add3fe16af38955ac',
//   // friendly
//   '235f8ffd7a3f5ecd5de3408cfaad0d01a36a96195ff491850257bc5c3098b28b'
// ]

process.on('exit', cleanup)
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('uncaughtException', function (err) {
  console.log('Uncaught exception, caught in process catch-all: ' + err.message)
  console.log(err.stack)
})

var storagePath = path.resolve(argv.path)
mkdirp.sync(storagePath)

var app = express()
app.use(compression({ filter: function () { return true } }))
app.get('/ping', function (req, res) {
  res.status(200).end()
})

app.get('/info', function (req, res) {
  res.status(200).json(ENDPOINT_INFO)
})

var port = Number(argv.port) || Number(conf.port) || DEFAULT_PORT
server = app.listen(port)

var bRouter = new express.Router()
app.use('/blockchain', localOnly)
app.use('/blockchain', bRouter)
var blockchainProxy = new BlockchainProxy({
  path: path.join(storagePath, 'blockchainCache.json'),
  router: bRouter
})

onDestroy.push(function () {
  return Q.ninvoke(blockchainProxy, 'destroy')
})

run()

function run () {
  if (argv.seq) {
    // start one at a time to avoid
    // straining blockchain APIs
    providerNames.reduce(function (prev, name) {
      return prev
        .finally(function () {
          return runBank({
            name: name,
            conf: conf.providers[name],
            app: app
          })
        })
        .then(function () {
          console.log(name, 'is live at http://127.0.0.1:' + port + '/' + name.toLowerCase())
        })
        .catch(function (err) {
          console.error(err)
          console.log(err.stack)
          throw err
        })
    }, Q())
  } else {
    providerNames.forEach(function (name) {
      return runBank({
        name: name,
        conf: conf.providers[name],
        app: app
      })
      .then(function () {
        console.log(name, 'is live at http://127.0.0.1:' + port + '/' + name.toLowerCase())
      })
    })
  }

  console.log('Server running on port', port)
}

function runBank (opts) {
  typeforce({
    name: 'String',
    conf: 'Object',
    app: 'EventEmitter'
  }, opts)

  typeforce({
    bot: 'Object',
    port: '?Number'
  }, opts.conf)

  var app = opts.app
  var name = opts.name.toLowerCase()
  console.log('running bank:', name)

  var conf = opts.conf
  var bot = conf.bot
  var bankPort = conf.port || (DEFAULT_TIM_PORT++)
  var identity = bot.pub
  var keys = bot.priv

  var tim = buildNode({
    dht: false,
    port: bankPort,
    pathPrefix: path.join(storagePath, name),
    networkName: networkName,
    identity: Identity.fromJSON(identity),
    keys: keys,
    syncInterval: 60000,
    afterBlockTimestamp: afterBlockTimestamp,
    blockchain: new Blockchain(networkName, 'http://127.0.0.1:' + port + '/blockchain?url='),
  })

  tim.watchTxs(ENDPOINT_INFO.providers.filter(getTxId).map(getTxId))
  var bank = newSimpleBank({
    tim: tim,
    path: path.join(storagePath, name + '-customer-data.db'),
    name: opts.name,
    leveldown: leveldown,
    manual: true // receive msgs manually
  })

  var otrKey = keys.filter(function (k) {
    return k.type === 'dsa'
  })[0].priv

  var websocketRelay
  var websocketClient
  if (otrKey) {
    // websockets
    var wsPort = conf.wsPort
    debug('websockets enabled, port', wsPort)
    websocketRelay = new WebSocketRelay({
      port: wsPort
    })

    // bank bot websocket client
    websocketClient = new WebSocketClient({
      url: 'http://127.0.0.1:' + wsPort,
      otrKey: DSA.parsePrivate(otrKey)
    })

    app.get('/' + name + '/info', function (req, res) {
      res.status(200).json({
        ws: wsPort
      })
    })

    websocketClient.on('message', bank.receiveMsg)
    tim._send = websocketClient.send.bind(websocketClient)
    tim.ready().then(function () {
      websocketClient.setRootHash(tim.myRootHash())
    })
  }

  debug('http enabled, port', port)
  var router = express.Router()
  var httpServer = new HttpServer({
    router: router
  })

  httpServer.receive = bank.receiveMsg.bind(bank)
  tim.once('ready', function () {
    app.use('/' + name + '/send', router)
  })

  tim._send = function (toRootHash, msg, recipientInfo) {
    // TODO: figure out a better way to determine which transport
    // to send reply with
    var transport = websocketRelay && websocketRelay.hasClient(toRootHash)
      ? websocketClient
      : httpServer

    return transport.send.apply(transport, arguments)
  }

  bank.wallet.balance(function (err, balance) {
    if (err) return
    console.log(opts.name, ' Balance: ', balance)
    console.log(opts.name, ': Send coins to', bank.wallet.addressString)
  })

  if (networkName === 'testnet') {
    watchBalanceAndRecharge({
      wallet: bank.wallet,
      interval: 60000,
      minBalance: 1000000
    })
  }

  var byType = '/' + name + '/list/:type'
  app.get(byType, localOnly)
  app.get(byType, function (req, res, next) {
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

  // getIdentityPublishStatus(tim)

  return tim.identityPublishStatus()
    .then(function (status) {
      if (status.current) {
        console.log(opts.name, 'bank bot identity published')
      } else if (status.queued) {
        console.log(opts.name, 'bank bot identity queued for publish')
      } else {
        console.log(opts.name, 'queueing bank bot identity publish now...')
        // don't wait for this to finish
        tim.publishMyIdentity()
      }
    })
}

function sendErr (res, err) {
  var msg = DEV ? err.message : 'something went horribly wrong'
  res.status(500).send(msg + '\n' + err.stack)
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

  // timeout peaceful termination and murder it
  setTimeout(function () {
    process.exit(1)
  }, 5000).unref()

  Q.all(onDestroy.map(function (fn) {
      return fn()
    }))
    .done(function () {
      debug('shutting down')
      process.exit()
    })
}

function loadJSON (filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath)))
}

function printUsage () {
  console.log(function () {
  /*
  BANK SIMULATOR, DO NOT USE IN PRODUCTION

  Usage:
      # see sample-conf for conf format
      banks sample-conf/conf.json <options>


  Options:
      -h, --help              print usage
      -s, --seq               start banks sequentially
      -c, --chain             whether to write to blockchain (default: true)
      -b, --banks             banks to run (defaults to banks in conf that don't have run: false)
      -p, --path              directory to store data in
      --public                expose the server to non-local requests

  Please report bugs!  https://github.com/tradle/tim-bank/issues
  */
  }.toString().split(/\n/).slice(2, -2).join('\n'))
  process.exit(0)
}

function pick (obj) {
  var picked = {}
  for (var i = 1; i < arguments.length; i++) {
    var p = arguments[i]
    picked[p] = obj[p]
  }

  return picked
}

function getTxId (info) {
  return info.bot && info.bot.txId
}
