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
pgo.registerModel(Account, moduleName)    

class AccountAggregation extends Model {
    constructor(data) {
        super(data)
    }
}
AccountAggregation.structure = [
    ["account", { "type": "foreignKey", "target": "Account" }],
    ["type", { "type": "string", "maxLength": 10}],    
    ["roi", { "type": "decimal", "optional": true, default: 0}],
    ["totalProfits", { "type": "decimal", default: 0 }]
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

        // this is optional: prevents inflated ROI in case
        // return was generated using credits from this period
        // baseInvest += this.getNetCredit()

        return profit / baseInvestment
    }

    updateTotals(lastWr) {
        this.totalCredits = lastWr.totalCredits + (this.credits || 0)
        this.totalDebits = lastWr.totalDebits + (this.debits || 0)
        this.totalProfits = lastWr.totalProfits + (this.profits || 0)
    }
}
AccountSummary.structure = [
    ["account", { "type": "foreignKey", "target": "Account" }],    
    ["date", { "type": "date" }],
    ["credits", { "type": "decimal", "default": 0 }],
    ["debits", { "type": "decimal", "default": 0 }],
    ["profits", { "type": "decimal", "default": 0 }],
    ["countClosePositions", { "type": "integer", "default": 0 }],
    ["endBalance", { "type": "text", "optional": true }],

    ["totalCredits", { "type": "decimal", "optional": true }],
    ["totalDebits", { "type": "decimal", "optional": true }],
    ["totalProfits", { "type": "decimal", "optional": true }]
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
        this.openTradeId = peer.tradeId

        if (this.isClosePosition() ) {
            this.profits = this.boughtAmount - (peer.soldAmount * soldPercent)
            this.profits = roundTo(this.profits, 7)
        }
    }
}
Position.structure = [
    ["account", { "type": "foreignKey", "target": "Account"}],    
    ["tradeId", { "type": "text"}],
    ["boughtAsset", { "type": "string", "maxLength": 80 }],    
    ["boughtAmount", { "type": "decimal", "default": 0 }],
    ["openAmount", { "type": "decimal", "default": 0 }],
    ["soldAsset", { "type": "string", "maxLength": 80 }],
    ["soldAmount", { "type": "decimal", "default": 0 }],
    ["openTradeId", { "type": "text", "optional":true}],
    // profits in XLM
    ["profits", { "type": "decimal", "default": 0}],
    ["time", { "type": "datetime" }]
]

pgo.registerModel(Position, moduleName)

