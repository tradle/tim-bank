#!/usr/bin/env node
'use strict';

// var ppfile = require('ppfile')
var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    i: 'identity',
    k: 'keys',
    t: 'tim-port',
    p: 'port',
    h: 'help'
  },
  default: {
    port: 33333,
    'tim-port': 44444,
    storage: './storage'
  }
});

if (argv.help) {
  printUsage();
  process.exit(0);
}

if (!(argv.identity && argv.keys)) {
  console.error('identity and keys are required');
  printUsage();
  process.exit(0);
}

// moved requires for these after arg processing
// to speed up --help query

require('@tradle/multiplex-utp');

var path = require('path');
var fs = require('fs');
var dns = require('dns');
var debug = require('debug')('bankd');
var express = require('express');
var leveldown = require('leveldown');
var constants = require('@tradle/constants');
var Bank = require('./');
var buildNode = require('./lib/buildNode');
var Identity = require('tim').Identity;
var createServer = require('tim-server');
var Zlorp = require('tim').Zlorp;
Zlorp.ANNOUNCE_INTERVAL = 10000;
Zlorp.LOOKUP_INTERVAL = 10000;
var DEV = process.env.NODE_ENV === 'development';

// ppfile.decrypt(argv, function (err, contents) {
//   console.log(err || contents)
// })

var server;
var selfDestructing;
var destroy;
process.on('exit', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', function (err) {
  console.log('Uncaught exception, caught in process catch-all: ' + err.message);
  console.log(err.stack);
});

run();

function run() {
  var identity = JSON.parse(fs.readFileSync(path.resolve(argv.identity)));
  // ppfile.decrypt({ in: argv.keys }, function () {
  var keys = JSON.parse(fs.readFileSync(path.resolve(argv.keys)));

  dns.resolve4('tradle.io', function (err, addrs) {
    if (err) throw err;

    var tim = buildNode({
      ip: addrs[0],
      port: argv['tim-port'],
      networkName: 'testnet',
      identity: Identity.fromJSON(identity),
      identityKeys: keys,
      syncInterval: 300000,
      afterBlockTimestamp: constants.afterBlockTimestamp,
      relay: {
        address: addrs[0],
        port: 25778
      }
    });

    var bank = new Bank({
      tim: tim,
      path: argv.storage,
      leveldown: leveldown
    });

    bank.wallet.balance(function (err, balance) {
      console.log('Balance: ', balance);
      console.log('Send coins to: ', bank.wallet.addressString);
    });

    printIdentityPublishStatus(tim);

    if (!argv.port) return;

    var app = express();
    server = app.listen(argv.port);

    destroy = createServer({
      tim: tim,
      app: app,
      public: argv.public
    });

    app.get('/list/:type', function (req, res, next) {
      bank.list(req.params.type).then(res.json.bind(res)).catch(sendErr.bind(null, res));
    });

    console.log('Server running on port', argv.port);
  });
  // })
}

function sendErr(res, err) {
  var msg = DEV ? err.message : 'something went horribly wrong';
  res.status(500).send(err.message + '\n' + err.stack);
}

function printIdentityPublishStatus(tim) {
  tim.identityPublishStatus().then(function (status) {
    var msg = 'identity status: ';
    if (status.current) msg += 'published latest';else if (status.queued) msg += 'queued for publishing';else if (!status.ever) msg += 'unpublished';else msg += 'published, needs republish';

    console.log(msg);
  }).catch(function (err) {
    console.error('failed to get identity status', err.message);
  });
}

function cleanup() {
  if (selfDestructing || !server) return;

  selfDestructing = true;
  debug('cleaning up before shut down...');
  try {
    server.close();
  } catch (err) {}

  destroy().done(function () {
    debug('shutting down');
    process.exit();
  });
}

function printUsage() {
  console.log((function () {
    /*
    BANK SIMULATOR, DO NOT USE IN PRODUCTION
     Usage:
        bank -i ./identity.json -k ./keys.json <options>
     Example:
        bank -i ./identity.json -k ./keys.json -p 12345 -t 54321
     Options:
        -h, --help              print usage
        -i, --identity [path]   path to identity JSON [REQUIRED]
        -k, --keys [path]       path to private keys file (for identity) [REQUIRED]
        -p, --port [number]     server port (default: 33333)
        -t, --tim-port [number] port tim will run on (default: 44444)
        -s                      storage path (default: './storage')
        --public                expose the server to non-local requests
     Please report bugs!  https://github.com/tradle/tim-bank/issues
    */
  }).toString().split(/\n/).slice(2, -2).join('\n'));
  process.exit(0);
}

// function print (cb) {
//   walk('./', function (err, results) {
//     if (results && results.length) {
//       results.forEach(function (r) {
//         console.log(r)
//       })
//     }

//     cb()
//   })
// }

// function walk (dir, done) {
//   var results = []
//   fs.readdir(dir, function(err, list) {
//     if (err) return done(err)
//     var pending = list.length
//     if (!pending) return done(null, results)
//     list.forEach(function(file) {
//       file = path.resolve(dir, file)
//       fs.stat(file, function(err, stat) {
//         if (stat && stat.isDirectory()) {
//           walk(file, function(err, res) {
//             results = results.concat(res)
//             if (!--pending) done(null, results)
//           })
//         } else {
//           results.push(file)
//           if (!--pending) done(null, results)
//         }
//       })
//     })
//   })
// }

// function clear (cb) {
//   var togo = 1
//   rimraf('./', setTimeout.bind(null, finish, 100))

//   ;[
//     'addressBook.db',
//     'msg-log.db',
//     'messages.db',
//     'txs.db'
//   ].forEach(function (dbName) {
//     ;[pub].forEach(function (identity) {
//       togo++
//       leveldown.destroy(getPrefix(identity) + '-' + dbName, finish)
//     })
//   })

//   function finish () {
//     if (--togo === 0) cb()
//   }
// }