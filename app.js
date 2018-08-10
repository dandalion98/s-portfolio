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
    fs = require('fs'),
    log4js = require('log4js'),
    config = require("./config/config");

require('app-module-path').addPath("./common_modules")
require("./src/models")

if (config.env == 'dev') {
  let LOG_FILES = ['./logs/update-account.log', './logs/aggs.log', './logs/value.log']
  for (let lf of LOG_FILES) {
    try {
      fs.unlinkSync(lf)
    } catch (e) { }
  }
}

log4js.configure(config.logging);

log.error("testint")
var logr = log4js.getLogger('updateAccount');
logr.error("test123")


let controllers = require('./src/controller')
// let seed = require('./src/seed')

async function periodicSyncAccounts() {
  log.info("periodic sync account")
  try {
    await controllers.syncAccounts()
  } catch (error) {
    log.error(error)
  }
  scheduleSyncAcccounts()
}

function scheduleSyncAcccounts(timeout) {
  if (undefined === timeout) {
    timeout = 15 * 60 * 1000
  }
  setTimeout(periodicSyncAccounts, timeout)
}

async function main() { 
  await initPG()

  scheduleSyncAcccounts(0)

//   await seed.seed()

  await controllers.test() 

  log.info("Starting server on port: " + config.port)
  var app = express();

  const bodyParser = require('body-parser');
  app.use(bodyParser({ limit: '50mb' }));


  app.listen(config.port);
  app.on('error', function (err) {

    console.log('on error handler'); 
    console.log(err);
  });
  controllers.registerRoutes(app)
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
