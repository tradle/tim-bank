#!/usr/bin/env node
'use strict';

require('babel-polyfill');
var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    p: 'public',
    h: 'help',
    s: 'seq',
    c: 'chain'
  },
  default: {
    chain: true
  }
});

if (argv.help) {
  printUsage();
  process.exit(0);
}

var path = require('path');
var fs = require('fs');
var typeforce = require('typeforce');
var Q = require('q');
var debug = require('debug')('bankd');
var leveldown = require('leveldown');
var constants = require('@tradle/constants');
var Bank = require('./');
Bank.ALLOW_CHAINING = argv.chain;
var buildNode = require('./buildNode');
var Tim = require('tim');
var HttpServer = Tim.Messengers.HttpServer;
var Identity = Tim.Identity;
var installServer = require('tim-server');
var Zlorp = require('tim').Zlorp;
Zlorp.ANNOUNCE_INTERVAL = 10000;
Zlorp.LOOKUP_INTERVAL = 10000;
var DEV = process.env.NODE_ENV === 'development';
var DEFAULT_PORT = 44444;
var DEFAULT_TIM_PORT = 34343;

var confPath = process.argv[2];
var conf = require(path.resolve(confPath));
if (!conf) throw new Error('specify conf file path');

var express = require('express');
var server;
var selfDestructing;
var onDestroy = [];
process.on('exit', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', function (err) {
  console.log('Uncaught exception, caught in process catch-all: ' + err.message);
  console.log(err.stack);
});

run();

function run() {
  var app = express();
  var port = Number(conf.port) || DEFAULT_PORT;
  server = app.listen(port);

  var bankNames = Object.keys(conf.banks).filter(function (name) {
    return conf.banks[name].run !== false;
  });

  if (argv.seq) {
    // start one at a time to avoid
    // straining blockchain APIs
    bankNames.reduce(function (prev, name) {
      return prev.finally(function () {
        return runBank({
          name: name,
          conf: conf.banks[name],
          app: app
        }).then(function () {
          console.log(name, 'is live at http://127.0.0.1:' + port + '/' + name.toLowerCase());
        });
      });
    }, Q());
  } else {
    bankNames.forEach(function (name) {
      return runBank({
        name: name,
        conf: conf.banks[name],
        app: app
      }).then(function () {
        console.log(name, 'is live at http://127.0.0.1:' + port + '/' + name.toLowerCase());
      });
    });
  }

  console.log('Server running on port', port);
}

function runBank(opts) {
  typeforce({
    name: 'String',
    conf: 'Object',
    app: 'EventEmitter'
  }, opts);

  typeforce({
    pub: 'String',
    priv: 'String',
    port: '?Number'
  }, opts.conf);

  var app = opts.app;
  var name = opts.name.toLowerCase();
  console.log('running', name);

  var conf = opts.conf;
  var port = conf.port || DEFAULT_TIM_PORT++;
  var identity = loadJSON(conf.pub);
  var keys = loadJSON(conf.priv);

  var router = express.Router();
  var httpServer = new HttpServer({
    router: router
  });

  var tim = buildNode({
    dht: false,
    port: port,
    networkName: 'testnet',
    identity: Identity.fromJSON(identity),
    identityKeys: keys,
    syncInterval: 120000,
    afterBlockTimestamp: constants.afterBlockTimestamp,
    messenger: httpServer
  });

  var bank = new Bank({
    tim: tim,
    path: conf.storage || name + '-storage',
    leveldown: leveldown,
    manual: true // receive msgs manually
  });

  httpServer.receive = bank.receiveMsg.bind(bank);
  tim.once('ready', function () {
    app.use('/' + name + '/send', router);
  });

  bank.wallet.balance(function (err, balance) {
    if (err) return;
    console.log(opts.name, ' Balance: ', balance);
    console.log(opts.name, ': Send coins to', bank.wallet.addressString);
  });

  app.get('/' + name + '/list/:type', function (req, res, next) {
    bank.list(req.params.type).then(res.json.bind(res)).catch(sendErr.bind(null, res));
  });

  var timRouter = express.Router();
  app.use('/' + name, timRouter);

  installServer({
    tim: tim,
    app: timRouter,
    public: argv.public
  });

  onDestroy.push(bank.destroy);

  // getIdentityPublishStatus(tim)

  return tim.identityPublishStatus().then(console.log.bind(console, opts.name));
}

function sendErr(res, err) {
  var msg = DEV ? err.message : 'something went horribly wrong';
  res.status(500).send(msg + '\n' + err.stack);
}

function getIdentityPublishStatus(tim) {
  return tim.identityPublishStatus().then(function (status) {
    var msg = 'identity status: ';
    if (status.current) msg += 'published latest';else if (status.queued) msg += 'queued for publishing';else if (!status.ever) msg += 'unpublished';else msg += 'published, needs republish';

    return msg;
  }).catch(function (err) {
    console.error('failed to get identity status', err.message);
    throw err;
  });
}

function cleanup() {
  if (selfDestructing || !server) return;

  selfDestructing = true;
  debug('cleaning up before shut down...');
  try {
    server.close();
  } catch (err) {}

  Q.all(onDestroy).done(function () {
    debug('shutting down');
    process.exit();
  });
}

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath)));
}

function printUsage() {
  console.log((function () {
    /*
    BANK SIMULATOR, DO NOT USE IN PRODUCTION
     Usage:
        banks path/to/conf.json
     Example conf.json:
        {
          "port": 44444,
          "banks": {
            "Lloyds": {
              "priv": "/path/to/lloyds-priv.json",
              "pub": "/path/to/lloyds-pub.json",
              "port": 12321
            },
            "Rabobank": {
              "run": false,
              "priv": "/path/to/rabo-priv.json",
              "pub": "/path/to/rabo-pub.json",
              "port": 32123
            }
          }
        }
     Options:
        -h, --help              print usage
        -s, --seq               start banks sequentially
        --public                expose the server to non-local requests
     Please report bugs!  https://github.com/tradle/tim-bank/issues
    */
  }).toString().split(/\n/).slice(2, -2).join('\n'));
  process.exit(0);
}