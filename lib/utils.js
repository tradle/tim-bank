'use strict';

var debug = require('debug')('bank:utils');
var Q = require('q');
var constants = require('@tradle/constants');
var SIMPLE_MSG_REGEX = /^\[([^\]]+)\]\(([^\)]+)\)/;

var utils = module.exports = {
	parseSimpleMsg: function parseSimpleMsg(msg) {
		var match = msg.match(SIMPLE_MSG_REGEX);
		if (!match) return {};

		return {
			message: match[1],
			type: match[2]
		};
	},

	buildSimpleMsg: function buildSimpleMsg(msg, type) {
		var sMsg = {};
		sMsg[constants.TYPE] = constants.TYPES.SIMPLE_MESSAGE;
		sMsg.message = '[' + msg + ']' + '(' + type + ')';
		return sMsg;
	},

	waitForEvent: function waitForEvent(tim, event, entry) {
		var self = this;
		var uid = entry.get('uid');
		debug('waiting for', uid);
		tim.on(event, handler);
		var defer = Q.defer();
		return defer.promise;

		function handler(metadata) {
			if (metadata.uid === uid) {
				debug('done waiting for', uid);
				tim.removeListener(event, handler);
				defer.resolve(metadata);
			}
		}
	},

	/**
  * middleware processor
  * @return {Object} middleware with `use` and `exec` functions
  */
	middles: function middles() {
		var middles = [];
		return {
			use: function use(fn) {
				middles.push(fn);
			},
			exec: function exec(req, res) {
				return middles.reduce(function (promise, middle) {
					return promise.then(function () {
						return middle(req, res);
					});
				}, Q());
			}
		};
	}
};