#!/usr/bin/env node

var fs = require('fs')
var path = require('path')
var Q = require('q')
var utils = require('./utils')
var argv = require('minimist')(process.argv.slice(2), {
  alias: {
    f: 'file',
    c: 'count',
    n: 'networkName'
  },
  default: {
    c: 100,
    n: 'testnet'
  }
})

var users = []
var count = Number(argv.count)
var filePath = path.resolve(argv.file)
var opts = { networkName: argv.networkName }
var promises = []
for (var i = 0; i < count; i++) {
  promises.push(Q.ninvoke(utils, 'genUser', opts))
}

Q.all(promises)
  .then((users) => {
    fs.writeFile(filePath, JSON.stringify(users, null, 2))
  })
