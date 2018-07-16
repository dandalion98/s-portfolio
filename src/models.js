let moduleName = "sportfolio"

var pgo = require('pg-orm'),
    _ = require('lodash'),
    path = require('path'),
    config = require(path.resolve("config/config")),
    log = require('tracer').colorConsole(),
    stellarPay = require("stellar-pay"),
    toDS = stellarPay.toDS,
    fromDS = stellarPay.fromDS,
    bd = require('bigdecimal'),
    BigDecimal = bd.BigDecimal,
    RoundingMode = bd.RoundingMode,
    roundTo = require('round-to'),
    moment = require("moment"),
    Model = pgo.Model;

// Fix for parsing of numeric fields
var types = require('pg').types
types.setTypeParser(1700, 'text', parseFloat);

class Account extends Model {
    constructor(data) {
        super(data)
    }
}
Account.structure = [
    ["address", { "type": "string", "maxLength": 60, "unique": true, "index": true }],
    ["name", { "type": "text", "optional": true}],
    ["desc", { "type": "text", "optional": true }],
    ["mirror", { "type": "foreignKey", "target": "Account", "optional": true }],
    // error status
    ["status", { "type": "string", "maxLength": 15, "optional":true }],
    ["lastUpdateTime", { "type": "datetime", "optional": true }]
]
pgo.registerModel(Account, moduleName)    

class AccountAggregation extends Model {
    constructor(data) {
        super(data)
    }
}
AccountAggregation.structure = [
    ["account", { "type": "foreignKey", "target": "Account", deleteCascade: true }],
    ["type", { "type": "string", "maxLength": 10}],    
    ["roi", { "type": "decimal", "optional": true, default: 0}],
    ["totalProfits", { "type": "decimal", default: 0 }],
    ["totalTrades", { "type": "integer", default: 0}],
    ["totalWinningTrades", { "type": "integer", default: 0 }]
]

AccountAggregation.constraints = [
    "ADD UNIQUE (account, \"type\")"
]

pgo.registerModel(AccountAggregation, moduleName)    

class AccountSummary extends Model {
    constructor(data) {
        super(data)
    }

    getBaseInvestment() {
        return this.totalCredits - this.totalDebits
    }

    getNetCredit() {
        return this.credits - this.debits
    }

    getRoi(start) {
        // profits made in this period
        let profit 
        
        if (this.id == start.id) {
            profit = this.profits
        } else {
            profit = this.totalProfits - start.totalProfits
        }

        // base investment at start of period
        let baseInvestment = start.getBaseInvestment()

        // prevents inflated ROI in case
        // return was generated using credits from this period
        let netCredits = this.totalCredits - start.totalCredits
        baseInvestment += netCredits

        return profit / baseInvestment
    }

    updateTotals(prevOrSameDayRecord) {
        log.error("udpating tot last")
        console.dir(prevOrSameDayRecord)

        this.totalCredits = +prevOrSameDayRecord.totalCredits + (this.credits || 0)
        this.totalDebits = +prevOrSameDayRecord.totalDebits + (this.debits || 0)
        this.totalProfits = +prevOrSameDayRecord.totalProfits + (this.profits || 0)
        
        this.totalTrades = +prevOrSameDayRecord.totalTrades + (this.trades || 0)
        this.totalWinningTrades = +prevOrSameDayRecord.totalWinningTrades + (this.winningTrades || 0)

        this.totalCredits = roundTo(this.totalCredits, 7)
        this.totalDebits = roundTo(this.totalDebits, 7)
        this.totalProfits = roundTo(this.totalProfits, 7)
        
    }
}
AccountSummary.structure = [
    ["account", { "type": "foreignKey", "target": "Account", deleteCascade: true }],    
    ["date", { "type": "date" }],
    ["credits", { "type": "decimal", "default": 0 }],
    ["debits", { "type": "decimal", "default": 0 }],
    ["profits", { "type": "decimal", "default": 0 }],
    ["trades", { "type": "decimal", "default": 0 }],
    ["winningTrades", { "type": "decimal", "default": 0 }],
    ["countClosePositions", { "type": "integer", "default": 0 }],
    ["endBalance", { "type": "text", "optional": true }],

    ["totalCredits", { "type": "decimal", "optional": true }],
    ["totalDebits", { "type": "decimal", "optional": true }],
    ["totalProfits", { "type": "decimal", "optional": true }],
    ["totalTrades", { "type": "integer", "optional": true}],
    ["totalWinningTrades", { "type": "integer", "optional": true }],

    ["lastEffectId", { "type": "text" }],
    ["valueXlm", { "type": "decimal", optional: true }],
    ["valueUsd", { "type": "decimal", optional: true }]
]

pgo.registerModel(AccountSummary, moduleName)    

// at end of each day, get all accounts where positions added today; 
// compute summary

class Position extends Model {
    constructor(data) {
        super(data)
    }

    isClosePosition() {
        return (this.boughtAsset == "native")
    }

    isOpenPosition() {
        return (this.soldAsset == "native")
    }

    // Traverse down peer chain to get open position.
    // Note: this requires peer position graph to be built
    getOpenPosition() {
        if (this.isOpenPosition()) {
            return this
        }

        let t = this.peer()
        while (t && !t.isOpenPosition()) {
            t = t.peer()
        }

        return t
    }

    clone(newAttrs) {
        let out = Object.assign({}, this)
        out = Object.assign(out, newAttrs)
        return new Position(out)
    }

    // Split a close position against multiple open positions
    split(peers) {
        if (!this.isClosePosition) {
            throw new Error("Cannot split a non-close position")
        }

        if (this.id) {
            throw new Error("Cannot split saved position: " + this.id)
        }

        if (this.openTradeId) {
            console.dir(this)
            throw new Error("Cannot split a position that's already matched")
        }

        if (peers.length == 1) {
            return [this]
        }

        let out = []
        let remainingAmount = this.soldAmount
        for (let peer of peers) {
            if (remainingAmount < 0) {
                throw new Error("amount mismatch")
            }

            let soldAmount = Math.min(remainingAmount, peer.openAmount)
            let soldPercentage = soldAmount / this.soldAmount
            let boughtAmount = roundTo(soldPercentage * this.boughtAmount, 7)

            out.push(this.clone({soldAmount: soldAmount, boughtAmount: boughtAmount}))     
            remainingAmount -= peer.openAmount       
        }

        return out
    }

    match(peer) {
        if (peer.openAmount < this.soldAmount) {
            throw new Error("not enough open amount in peer")
        }
        
        let soldPercent = this.soldAmount / peer.openAmount
        peer.openAmount -= this.soldAmount
        peer.openAmount = roundTo(peer.openAmount, 7)
        this.openTradeId = peer.tradeId

        if (this.isClosePosition() ) {
            this.profits = (this.soldPrice - peer.boughtPrice) * this.soldAmount
            this.closeBasisPrice = peer.boughtPrice
            this.profits = roundTo(this.profits, 7)
        }
    }

    round(precision) {
        this.boughtAmount = this.boughtAmount.toFixed(precision)
        this.boughtPrice = this.boughtPrice.toFixed(precision)
        this.openAmount = this.openAmount.toFixed(precision)
        this.soldAmount = this.soldAmount.toFixed(precision)
        this.soldPrice = this.soldPrice.toFixed(precision)
        if (this.closeBasisPrice) {
            this.closeBasisPrice = this.closeBasisPrice.toFixed(precision)
        }
        this.profits = this.profits.toFixed(precision)
    }

    // round(precision) {
    //     this.boughtAmount = roundTo(this.boughtAmount, precision)
    //     this.boughtPrice = roundTo(this.boughtPrice, precision)
    //     this.openAmount = roundTo(this.openAmount, precision)
    //     this.soldAmount = roundTo(this.soldAmount, precision)
    //     this.soldPrice = roundTo(this.soldPrice, precision)
    //     if (this.closeBasisPrice) {
    //         this.closeBasisPrice = roundTo(this.closeBasisPrice, precision)            
    //     }
    //     this.profits = roundTo(this.profits, precision)
    // }
}
Position.structure = [
    ["account", { "type": "foreignKey", "target": "Account", deleteCascade: true}],    
    ["tradeId", { "type": "text"}],
    // open or close
    ["type", { "type": "string", "maxLength": 10 }],

    ["boughtAsset", { "type": "string", "maxLength": 80 }],    
    ["boughtAmount", { "type": "decimal", "default": 0 }],
    ["boughtPrice", { "type": "decimal", "default": 0 }],

    ["openAmount", { "type": "decimal", "default": 0 }],
    ["soldAsset", { "type": "string", "maxLength": 80 }],
    ["soldAmount", { "type": "decimal", "default": 0 }],
    ["soldPrice", { "type": "decimal", "default": 0 }],
    // Cost basis price for close positions
    ["closeBasisPrice", { "type": "decimal", "default": 0, "optional": true }],
        
    ["openTradeId", { "type": "text", "optional":true}],
    // profits in XLM
    ["profits", { "type": "decimal", "default": 0}],
    ["time", { "type": "datetime" }]
]

pgo.registerModel(Position, moduleName)