'use strict';

var typeforce = require('typeforce');
var express = require('express');
var createServer = require('tim-server');
var Bank = require('./');

module.exports = function (options) {
	typeforce({
		bank: 'Object',
		port: 'Number'
	});

	var app = express();
	var server = app.listen(options.port);

	createServer({
		tim: options.bank._tim,
		app: app
	});
};