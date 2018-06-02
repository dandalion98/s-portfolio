let moduleName = "sportfolio"

var pgo = require('pg-orm'),
    _ = require('lodash'),
    path = require('path'),
    config = require(path.resolve("config/config")),
    log = require('tracer').colorConsole(),
    stellarPay = require("stellar-pay"),
    core = require("server-core"),
    toDS = stellarPay.toDS,
    fromDS = stellarPay.fromDS,
    bd = require('bigdecimal'),
    BigDecimal = bd.BigDecimal,
    RoundingMode = bd.RoundingMode,
    roundTo = require('round-to'),
    randomNumber = require('random-number'),
    slug = require("slug"),
    moment = require("moment"),
    Model = pgo.Model;

class Account extends Model {
    constructor(data) {
        super(data)
    }
}
Account.structure = [
    ["address", { "type": "string", "maxLength": 60 }],
    ["name", { "type": "text", "optional": true}],
    ["desc", { "type": "text", "optional": true }],
    ["mirror", { "type": "foreignKey", "target": "Account", "optional": true }]
]

class AccountProfits extends Model {
    constructor(data) {
        super(data)
    }
}
AccountProfits.structure = [
    ["account", { "type": "foreignKey", "target": "Account" }],    
    ["week", { "type": "date" }],
    ["amount", { "type": "long", "default": 0 }]    
]

pgo.registerModel(AccountProfits, moduleName)    

// at end of each day, get all accounts where positions added today; 
// compute summary

class Position extends Model {
    constructor(data) {
        super(data)
    }
}
Position.structure = [
    ["account", { "type": "foreignKey", "target": "Account"}],    
    ["tradeId", { "type": "text", "maxLength": 20 }],
    ["value", { "type": "long", "default": 0 }],
    ["peer", { "type": "foreignKey", "target": "Position", "optional": true }],
    ["time", { "type": "datetime" }]
]

pgo.registerModel(Position, moduleName)

