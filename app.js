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
    log4js = require('log4js'),
    fs = require('fs'),
  config = require("./config/config");

require('app-module-path').addPath("./common_modules")
require("./src/models")


let LOG_FILES = ['./logs/main.log', './logs/aggs.log', './logs/value.log']
for (let lf of LOG_FILES) {
  try {
    fs.unlinkSync(lf)
  } catch (e) { }
}

log4js.configure({
  appenders: { main: { type: 'file', filename: 'logs/main.log', level: 'debug' },
               aggs: { type: 'file', filename: 'logs/aggs.log', level: 'debug' },
               value: { type: 'file', filename: 'logs/value.log', level: 'debug' },
               },
  categories: { default: { appenders: ['main', 'aggs', 'value'], level: 'debug' } }
});

var logr = log4js.getLogger('aggs');
logr.error("AGGS")


let controllers = require('./src/controller')
// let seed = require('./src/seed')


async function main() { 
  await initPG()

//   await seed.seed()

  // await controllers.test() 

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
