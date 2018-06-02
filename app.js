'use strict';

var _ = require('lodash'),
  path = require('path'),
  log = require('tracer').colorConsole(),
  colors = require("colors"),
  queryLog = require('tracer').colorConsole({
    methods:["info"],
    filters:[colors.grey]
    }),  
  moment=require('moment'), 
    express = require('express'),
    config = require('./config/config'),
    StellarSdk = require('stellar-sdk'),
    util = require('util');


async function main() {
    fetchTrades();
}

var app = express();
app.listen(config.port);
app.on('error', function (err) {
    console.log('on error handler');
    console.log(err);
});


process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});