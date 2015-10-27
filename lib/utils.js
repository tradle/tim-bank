
var constants = require('tradle-constants')
var SIMPLE_MSG_REGEX = /^\[([^\]]+)\]\(([^\)]+)\)/

var utils = module.exports = {
	parseSimpleMsg: function (msg) {
	  var match = msg.match(SIMPLE_MSG_REGEX)
	  if (!match) return {}

	  return {
	    message: match[1],
	    type: match[2]
	  }
	},

	buildSimpleMsg: function (msg, type) {
	  var sMsg = {}
    sMsg[constants.TYPE] = constants.TYPES.SIMPLE_MESSAGE
		sMsg.message = '[' + msg + ']' + '(' + type + ')'
		return sMsg
	}
}
