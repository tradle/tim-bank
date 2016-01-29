#!/usr/bin/env node

var path = require('path')
var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    p: 'public',
    h: 'help',
    s: 'seq',
    c: 'chain',
    b: 'banks',
    p: 'path'
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
var Q = require('q')
var debug = require('debug')('bankd')
var leveldown = require('leveldown')
var constants = require('@tradle/constants')
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

var bankNames = argv.banks
  ? argv.banks.split(',').map(function (b) {
    return b.trim()
  })
  : Object.keys(conf.banks).filter(function (name) {
    return conf.banks[name].run !== false
  })

bankNames.forEach(function (bankName) {
  if (!(bankName in conf.banks)) {
    throw new Error('no bank with name: ' + bankName)
  }
})

var ENDPOINT_INFO = {
  providers: bankNames.map(function (name) {
    var bConf = conf.banks[name]
    // TODO: remove `txId` when we stop using blockr
    // or when blockr removes its 200txs/address limit
    return pick(bConf, 'name', 'txId', 'wsPort', 'org')
  })
}

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

var port = Number(conf.port) || DEFAULT_PORT
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
    bankNames.reduce(function (prev, name) {
      return prev
        .finally(function () {
          return runBank({
            name: name,
            conf: conf.banks[name],
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
    bankNames.forEach(function (name) {
      return runBank({
        name: name,
        conf: conf.banks[name],
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
    pub: 'String',
    priv: 'String',
    port: '?Number'
  }, opts.conf)

  var app = opts.app
  var name = opts.name.toLowerCase()
  console.log('running bank:', name)

  var conf = opts.conf
  var bankPort = conf.port || (DEFAULT_TIM_PORT++)
  var identity = loadJSON(conf.pub)
  var keys = loadJSON(conf.priv)

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

  tim.watchTxs(ENDPOINT_INFO.providers.map(function (info) {
    return info.txId
  }))

  var bank = newSimpleBank({
    tim: tim,
    path: path.join(storagePath, name + '-customer-data.db'),
    name: opts.name,
    leveldown: leveldown,
    manual: true // receive msgs manually
  })

  // var otrKey = keys.filter(function (k) {
  //   return k.type === 'dsa'
  // })[0].priv

  // // TODO: allow both http and websockets endpoints
  // if (otrKey) {
  //   var wsPort = conf.wsPort
  //   debug('choosing websockets, port', wsPort)
  //   var websocketRelay = new WebSocketRelay({
  //     port: wsPort
  //   })

  //   // bank bot websocket client
  //   var websocketClient = new WebSocketClient({
  //     url: 'http://127.0.0.1:' + wsPort,
  //     otrKey: DSA.parsePrivate(otrKey)
  //   })

  //   app.get('/' + name + '/info', function (req, res) {
  //     res.status(200).json({
  //       ws: wsPort
  //     })
  //   })

  //   websocketClient.on('message', bank.receiveMsg)
  //   tim._send = websocketClient.send.bind(websocketClient)
  //   tim.ready().then(function () {
  //     websocketClient.setRootHash(tim.myRootHash())
  //   })
  // } else {
    var router = express.Router()
    var httpServer = new HttpServer({
      router: router
    })

    httpServer.receive = bank.receiveMsg.bind(bank)
    tim.once('ready', function () {
      app.use('/' + name + '/send', router)
    })

    tim._send = httpServer.send.bind(httpServer)
  // }

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
      console.log(opts.name, 'bank rep identity published:', status.current)
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
    picked[i] = obj[p]
  }

  return picked
}
