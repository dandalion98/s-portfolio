var _ = require('lodash'),
    stellarPay = require("stellar-pay"),
    log = require('tracer').colorConsole(),
    StellarSdk = require('stellar-sdk'),
    stellarServer = stellarPay.liveServer(),
    roundTo = require('round-to'),
    pgo = require('pg-orm'),
    Account = pgo.model("Account"),    
    Position = pgo.model("Position"),
    AccountSummary = pgo.model("AccountSummary"),
    AccountAggregation = pgo.model("AccountAggregation"),
    moment = require('moment'),
    fs = require('fs');

let NUMERICAL_FIELDS = ["sold_amount", "bought_amount", "amount"]
class AccountEffect {
    constructor(data) {
        Object.assign(this, data)

        this.time = new moment(this.created_at)

        for (let nf of NUMERICAL_FIELDS) {
            if (this[nf]) {
                this[nf] = +this[nf]
            }
        }

        if (this.sold_asset_type) {
            if ("native" == this.sold_asset_type) {
                this.sold_asset = "native"
            } else {
                this.sold_asset = `${this.sold_asset_code}-${this.sold_asset_issuer}`
            }
        }

        if (this.bought_asset_type) {
            if ("native" == this.bought_asset_type) {
                this.bought_asset = "native"
            } else {
                this.bought_asset = `${this.bought_asset_code}-${this.bought_asset_issuer}`
            }
        }

        if (this.asset_type) {
            if ("native" == this.asset_type) {
                this.asset = "native"
            } else {
                this.asset = `${this.asset_code}-${this.asset_issuer}`
            }
        }
    }

    parsePosition() {
        let p = new Position()
        p.tradeId = this.id
        p.boughtAsset = this.bought_asset
        p.boughtAmount = this.bought_amount
        p.soldAsset = this.sold_asset
        p.soldAmount = this.sold_amount
        // TOOD: map to account obj
        p.account = this.account
        p.time = this.time.toDate()
        // TODO: parse time

        if (p.boughtAsset != "native") {
            p.openAmount = p.boughtAmount
        }

        return p
    }
}    

class PositionMatcher {
    constructor() {
        this.openMap = {}
    }

    addOpenPosition(position) {
        let pc = position.boughtAsset
        if (!this.openMap[pc]) {
            this.openMap[pc] =[]
        }
        this.openMap[pc].push(position)
    }

    match(closePosition) {
        let rpc = closePosition.soldAsset
        if (!this.openMap[rpc]) {
            return
        }

        // if we find a single open position
        let exactMatch

        // in case there is no exact position; must handle multple open positions
        let multiMatches = []
        let multiSum = 0
        for (let openPosition of this.openMap[rpc]) {
            if (openPosition.boughtAmount == closePosition.soldAmount) {
                exactMatch = openPosition
                break
            }

            if (multiSum < closePosition.soldAmount) {
                multiMatches.push(openPosition)
                multiSum += openPosition.openAmount
            }
        }

        if (exactMatch) {
            return [exactMatch]
        } else if (multiSum >= closePosition.soldAmount) {
            return multiMatches
        } else {
            return null
        }
    }
}

class AccountEffects {
    constructor(data) {
        this.effects = []
        for (let t of data) {
            this.effects.push(new AccountEffect(t))
        }
    }

    parsePositions() {
        let positions = []
        for (let e of this.effects) {
            if (e.type!="trade") {
                continue
            }

            positions.push(e.parsePosition())
        }
        return positions
    }

    getPositions(existingPositions) {
        if (!existingPositions) {
            existingPositions = []
        }
        let newPositions = this.parsePositions()
        let allPositions = newPositions.concat(existingPositions)

        // try to close out positions

        // We may have more final positions due to splitting to match against open
        // TODO: check all positions are new (not already saved)
        let finalPositions = []
        let matcher = new PositionMatcher()
        for (let i=allPositions.length-1; i>=0; i--) {
            let position = allPositions[i]

            if (position.isOpenPosition()) {
                matcher.addOpenPosition(position)
                finalPositions.unshift(position)
            } else {
                let openPositions = matcher.match(position)
                if (openPositions) {
                    let closePositions = position.split(openPositions)
                    for (let j=0; j<openPositions.length; j++) {
                        closePositions[j].match(openPositions[j])
                        finalPositions.unshift(closePositions[j])
                    }                    
                }
            }
        }

        return finalPositions
    }

    // Note: computed balance will differ very slightly from
    // real balance because we have no insights into fees (e.g. failed tx)
    computeBalance(endBalance) {
        if (!this.effects.length) {
            return
        }

        for (let effect of this.effects) {  
            effect.endBalance = Object.assign({}, endBalance)

            if (effect.type=='trade') {
                endBalance[effect.sold_asset] += effect.sold_amount
                endBalance[effect.bought_asset] -= effect.bought_amount                
            } else if (effect.type == 'account_credited') {
                endBalance[effect.asset] -= effect.amount
            } else if (effect.type == 'account_debited') {
                endBalance[effect.asset] += effect.amount                
            }

            this.roundBalance(endBalance)
        }
    }

    roundBalance(balance) {
        for (let c in balance) {
            balance[c] = roundTo(balance[c], 7)
        }
    }
}  

class AccountSummarizer {
    // TODO: pass in account summary of prior 2 week in history
    constructor() {
        // maps a date (representing 1 day) to an AccountSummary
        this.dateMap = {}
    }

    getRecords() {
        return Object.values(this.dateMap)
    }

    ensureDateExists(dt, dtk) {
        if (!this.dateMap[dtk]) {
            this.dateMap[dtk] = new AccountSummary({ date: dt.toDate(), profits: 0 })
        }
        return this.dateMap[dtk]
    }

    // TODO: for reference, pass the weekrecord prior to the earliest effect's week record
    // TODO: ensure only new effects accounted for
    // Positions must have been already added at this point
    addEffects(effects) {
        let lastEffectPerDateMap = {}
        let dateList = []

        for (let e of effects) {
            let ws = e.time.startOf('day')
            let wsk = ws.toISOString()

            let record = this.ensureDateExists(ws, wsk)

            if (!lastEffectPerDateMap[wsk]) {
                lastEffectPerDateMap[wsk] = e
                dateList.unshift(record)
            }

            if (e.type =="account_debited") {
                record.debits = (record.debits || 0) + e.amount
            } else if (e.type == "account_credited") {
                record.credits = (record.credits || 0) + e.amount
            } // trades taken care of by positions
        }
        
        // compute net amounts for week records
        // TODO: init totals from prior week record (before any effects)
        let lastDateRecord = {totalCredits:0, totalDebits: 0, totalProfits: 0}
        for (let wr of dateList) {
            wr.updateTotals(lastDateRecord)
            lastDateRecord = wr
        }
    }

    addPositions(pos) {
        for (let i=pos.length-1; i>=0; i--) {
            let p = pos[i]

            // only account for new positions
            if (p.id) {
                continue
            }

            if (!p.isClosePosition()) {
                continue
            } 

            let ws = new moment(p.time).startOf('day')
            let wsk = ws.toISOString()
            let record = this.ensureDateExists(ws, wsk)

            record.profits += p.profits
        }
    }
}

var server = new StellarSdk.Server('https://horizon.stellar.org'); 

stellarServer = stellarPay.liveServer()

async function createTestAccount() {
    let a = await Account.objects.get({ address: "GA2ZTBK4SAJEZICUIPPJB6WCHSK7DO7CO3GH2VZMDHMRHK2JC2PDKCM4"})
    if (!a) {
        a = new Account({ address: "GA2ZTBK4SAJEZICUIPPJB6WCHSK7DO7CO3GH2VZMDHMRHK2JC2PDKCM4"})
        await a.save()
    }
    return a
}

module.exports.test = async function() {
    await pgo.truncateAll()

    let account = await createTestAccount()

    // let ainfo = { address: "GA2ZTBK4SAJEZICUIPPJB6WCHSK7DO7CO3GH2VZMDHMRHK2JC2PDKCM4"}
    // let a = stellarServer.getAccount(ainfo)
    // let balance = await a.getBalanceFull()
    // console.dir(balance)

    // let b = await a.listEffects()
    // var json = JSON.stringify(b, null, 4);
    // fs.writeFileSync("./effects.json", json, 'utf8');

    let balance = { native: 1533.51097 }

    let effects = require("../effects.json")
    let ae = new AccountEffects(effects)
    ae.computeBalance(balance)
    var json = JSON.stringify(ae.effects, null, 4);
    fs.writeFileSync("e2.json", json, 'utf8');

    let positions = ae.getPositions()
    writeJson(positions, "positions.json")

    let as = new AccountSummarizer()
    as.addPositions(positions)
    as.addEffects(ae.effects)

    writeJson(as.dateMap, "weekmap.json")

    for (let p of positions) {
        p.account = account
        await p.save()
    }

    for (let r of as.getRecords()) {
        r.account = account
        await r.save()
    }

    log.info('get start')
    let startOfMonth = moment().startOf('month').toDate()
    let start = await AccountSummary.objects.get({ date__gte: startOfMonth, orderBy: "date"})
    console.dir(start)

    let end = await AccountSummary.objects.get({ date__lte: moment().toDate(), orderBy:"-date" })
    console.dir(end)    

    let roi = end.getRoi(start)
    log.info("ROI="+roi)

    let start0 = await AccountSummary.objects.get({ orderBy: "date" })
    roi = end.getRoi(start0)
    log.info("ROI0=" + roi)

    await updateAggs(end)
}    

async function updateAggs(end) {
    let existingAggMap = {}
    let existingAggs = await AccountAggregation.objects.filter({account: end.account})
    for (let e of existingAggs) {
        existingAggMap[e.type] = e
    }

    let lastDays = [7, 30, 90]    
    for (let l of lastDays) {
        let aggType = `last${l}`
        let startDate = moment().subtract(l, "days")
        if (startDate > end.date) {
            // we're too late to make update
            continue
        }

        let start = await AccountSummary.objects.get({ date__gte: startDate, orderBy: "date" })

        let roi = end.getRoi(start)

        let agg = existingAggMap[aggType]
        if (!agg) {
            agg = new AccountAggregation({ account: end.account, type: aggType})
        }

        agg.roi = roi

        await agg.save()
        console.dir(agg)
    }
}

function writeJson(obj, fname) {
    var json = JSON.stringify(obj, null, 4);
    fs.writeFileSync(fname, json, 'utf8');
}


// server.trades()
//     .forAccount("GASNBEMVPNGCV3NQXHB7VYRRA57PVVD5JFBOSWHOONGE4WKRPUUN3JBX")
//     .call()
//     .then(function (accountResult) {
//         console.log(accountResult);
//     })
//     .catch(function (err) {
//         console.error(err);
//     })
