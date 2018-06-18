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
  config = require("./config/config");

require('app-module-path').addPath("./common_modules")
require("./src/models")
let proto = require('./src/proto')

async function main() {
  await initPG()

  await proto.test()
}

async function initPG() {
  let pgo = require('pg-orm')
  pgo.setConfig(config.db)
  // await pgo.dropdb()
  await pgo.init(false)
}


main()

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});