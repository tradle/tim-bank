
var test = require('tape')
var utils = require('../lib/utils')

test('versionGT', function (t) {
  t.ok(utils.versionGT('1.0.0', '0.9.10'))
  t.ok(utils.versionGT('1.2.1', '1.2.0'))
  t.ok(utils.versionGT('1.4.3', '1.2.3'))
  t.notOk(utils.versionGT('1.2.1', '1.2.1'))
  t.notOk(utils.versionGT('0.10.1', '1.9.0'))
  t.end()
})
