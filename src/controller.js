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
    fs = require('fs'),
    log4js = require('log4js'),
    AssetBalanceResolver = require("./balance").AssetBalanceResolver,
    portfolio = require("./portfolio"),
    AccountEffects = portfolio.AccountEffects,
    AccountSummarizer = portfolio.AccountSummarizer

var logger = log4js.getLogger('main');
// logger.setLevel('DEBUG');

var server = new StellarSdk.Server('https://horizon.stellar.org'); 

stellarServer = stellarPay.liveServer()

async function createTestAccount() {
    let a = await Account.objects.get({ address: "GDN6T23YXBL3JQBZUBU6NBQCNAPRQDGSTNU3QTYV6STDR5GDIIBKAWTM"})
    if (!a) {
        a = new Account({ address: "GDN6T23YXBL3JQBZUBU6NBQCNAPRQDGSTNU3QTYV6STDR5GDIIBKAWTM"})
        await a.save()
    }
    return a
}

function checkEffects() {
    let effects = require("../sample/e2.json")
    let totalBought = 0
    let totalSold = 0
    let outSold = {}
    
    for (let e of effects) {
        if (e.bought_asset_code=="EURT") {
            totalBought += e.bought_amount
        } else if (e.sold_asset_code == "EURT") {
            totalSold += e.sold_amount
            outSold[e.id] = (outSold[e.id] || 0) + e.sold_amount
        }
    }

    log.info(`effects bought=${totalBought} sold=${totalSold}`)
    return outSold
}

function checkPositions() {
    let positions = require("../sample/positions.json")
    let totalBought = 0
    let totalSold = 0
    let outSold = {}
    for (let p of positions) {
        if (p.type=="open") {
            totalBought += p.boughtAmount
        } else if (p.type=="close") {
            outSold[p.tradeId] = (outSold[p.tradeId] || 0) + p.soldAmount

            totalSold += p.soldAmount
        } else {
            throw new Error("unknown position type")
        }
    }

    log.info(`positions bought=${totalBought} sold=${totalSold}`)
    return outSold
}

module.exports.test = async function() {
    let account = await createTestAccount() 

    // let smp = checkPositions()
    // let sme = checkEffects()
    // for (let k in sme) {
    //     if (smp[k] != sme[k]) {
    //         log.error(`msimatch ${k} ${smp[k]} ${sme[k]}`)
    //     }
    // }

    await updateAccount(account)
}

async function listAccounts(request, response) {
    let out = await Account.objects.filter({})
    response.json(out)
}

async function createAccount(request, response) {
    log.info("creating account")
    let data = request.body
    // console.dir(data)
    let address = data.address
    if (!address) {
        throw new ServerError("no address", "no_address")
    }

    let existing = await Account.objects.get({address: address})
    if (existing) {
        if (existing.status) {
            console.dir(existing)
            throw new ServerError("Account creation failed due to previous failure", "prev_fail")
        } else {
            response.json(existing)
            return
        }
    }

    let a = new Account(data)
    await a.save()

    // TODO: handle failures
    await updateAccount(a, data.effects)

    response.json(a)
}

async function deleteAccount(request, response) {
    let account = request.account
    await account.delete()
    response.json({})
}

function filterNewEffects(effects, latestEffectId) {
    if (!latestEffectId) {
        return effects
    }

    let out = []
    for (let effect of effects) {
        if (effect.id == latestEffectId) {
            break
        }
        out.push(effect)
    }

    return out
}

async function updateAccount(account, effects) {
    let DONT_SAVE = false

    // await pgo.truncateAll()
    logger.debug("checking account", account)
    let latestDayRecord = await AccountSummary.objects.get({account:account, orderBy:"-date"})
    let latestEffectId = latestDayRecord ? latestDayRecord.lastEffectId : null
    logger.debug("checking latestDayRecord", latestDayRecord)

    let stellarAccount = stellarServer.getAccount({address: account.address})
    let balance = await stellarAccount.getBalanceFull()
    console.dir(balance) 

    logger.debug("---------------------------------------------------------------")
    logger.debug("getting effects latestTx="+latestEffectId)
    logger.debug("---------------------------------------------------------------")  
    if (!effects) { 
        effects = await stellarAccount.listEffects(latestEffectId)
    } else {
        effects = filterNewEffects(effects, latestEffectId)
    }
    // var json = JSON.stringify(b, null, 4);
    // fs.writeFileSync("./effects.json", json, 'utf8');

    logger.debug("---------------------------------------------------------------")
    logger.debug("parsing account effects")
    logger.debug("---------------------------------------------------------------") 
    // let effects = require("../effects.json")

    let ae = new AccountEffects(account, effects)
    ae.clean()    
    ae.computeBalance(balance)
    var json = JSON.stringify(ae.effects, null, 4);
    fs.writeFileSync("e2.json", json, 'utf8');

    // return

    logger.debug("---------------------------------------------------------------")
    logger.debug("parsing positions")
    logger.debug("---------------------------------------------------------------") 
    let existingOpenPositions = await Position.objects.filter({ account: account, type:"open", openAmount__gt:0, orderBy:"-time"})
    logger.debug("existing open positions", existingOpenPositions)

    let positions = ae.getPositions(existingOpenPositions)
    writeJson(positions, "positions.json")

    logger.debug("---------------------------------------------------------------")
    logger.debug("creating account summary")
    logger.debug("---------------------------------------------------------------") 
    let as = new AccountSummarizer(latestDayRecord)
    as.addPositions(positions)
    as.addEffects(ae.effects)

    let dm = _.clone(as.dateMap, true);
    let dmo = []
    for (let k in dm) {
        dmo.push(dm[k])
    }
    dmo.sort(function(a, b){
        return moment(a.date).valueOf() - moment(b.date).valueOf()
    })
    writeJson(dmo, "weekmap.json")

    if (DONT_SAVE) {
        return
    }

    await Position.objects.save(positions)

    let asr = as.getRecords()
    for (let r of asr) {
        r.account = account
    }
    await AccountSummary.objects.save(asr)

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
    var logr = log4js.getLogger('aggs');
    logr.debug("updating aggs end:", end)

    let existingAggMap = {}
    let existingAggs = await AccountAggregation.objects.filter({account: end.account})
    for (let e of existingAggs) {
        existingAggMap[e.type] = e
    }

    let outAggs = {}
    let lastDays = [7, 30, 90, 365]    
    for (let l of lastDays) {
        logr.debug("creating agg for " + l + " days")
        
        let aggType = `last${l}`
        let startDate = moment().subtract(l, "days")
        if (startDate > end.date) {
            // we're too late to make update
            logr.debug("skipping")
            continue
        }

        let start = await AccountSummary.objects.get({ account: end.account, date__lte: startDate, orderBy: "-date" })
        logr.debug("start", start)        
        if (!start) {
            logr.debug("no qualifying start found")
            continue
        }

        let roi = end.getRoi(start)

        let agg = existingAggMap[aggType]
        if (!agg) {
            agg = new AccountAggregation({ account: end.account, type: aggType})
        }

        agg.totalProfits = end.totalProfits - start.totalProfits
        agg.totalTrades = end.totalTrades - start.totalTrades
        agg.totalWinningTrades = end.totalWinningTrades - start.totalWinningTrades
        
        agg.roi = roi
        outAggs[l] = agg

        await agg.save()
        console.dir(agg)
    }

    return outAggs
}

function writeJson(obj, fname) {
    var json = JSON.stringify(obj, null, 4);
    fs.writeFileSync(fname, json, 'utf8');
}

async function getLeaders(request, response) {
    let type = request.params.type
    let leaders = await AccountAggregation.objects.filter({ type: type, roi__gt: 0, orderBy: "-roi" })
    for (let l of leaders) {
        let a = await l.get("account")
        l.address = a.address
    }
    response.json(leaders)
}

let STELLAR_PRECISION = 7
class ClosePositionAgg {
    constructor(asset) {
        this.asset = asset
        this.positions = []
        this.quantity = 0
        this.costBasis = 0
        this.liquidationAmount = 0
        this.profits = 0
    }

    addPosition(p) {
        this.positions.push(p)
        this.quantity += p.soldAmount
        this.costBasis += (p.soldAmount * p.closeBasisPrice)
        this.liquidationAmount += p.boughtAmount
        this.profits += p.profits

        if (!this.lastTime) {
            this.lastTime = p.time
        } else if (p.time > this.lastTime) {
            this.lastTime = p.time
        }

        p.round(STELLAR_PRECISION)
    }

    round() {
        this.quantity = roundTo(this.quantity, STELLAR_PRECISION)
        this.costBasis = roundTo(this.costBasis, STELLAR_PRECISION)
        this.liquidationAmount = roundTo(this.liquidationAmount, STELLAR_PRECISION)
        this.profits = roundTo(this.profits, STELLAR_PRECISION) 
    }
}

async function getClosedPositions(request, response) {
    let addr = request.params.accountId
    let account = await Account.objects.get({address:addr})
    if (!account) {
        throw new ServerError("Can't find account", "not_found")
    }

    let positions = await Position.objects.filter({account:account, type:"close", orderBy:"-time"})

    let aggMap = {}
    let aggs = []
    for (let p of positions) {
        if (!aggMap[p.soldAsset]) {
            aggMap[p.soldAsset] = new ClosePositionAgg(p.soldAsset)
            aggs.push(aggMap[p.soldAsset])
        }
        aggMap[p.soldAsset].addPosition(p)
    }

    for (let agg of aggs) {
        agg.round(STELLAR_PRECISION)
    }

    aggs.sort(function(a, b) {
        return b.lastTime - a.lastTime 
    })

    response.json(aggs)
}

class OpenPositionAgg {
    constructor(asset) {
        this.asset = asset
        this.positions = []
        this.quantity = 0
        this.costBasis = 0
    }

    addPosition(p) {
        this.positions.push(p)
        this.quantity += p.openAmount
        this.costBasis += (p.openAmount * p.boughtPrice)

        if (!this.lastTime) {
            this.lastTime = p.time
        } else if (p.time > this.lastTime) {
            this.lastTime = p.time
        }

        p.round(STELLAR_PRECISION)
    }

    round() {
        this.quantity = this.quantity.toFixed(STELLAR_PRECISION)
        this.costBasis = this.costBasis.toFixed(STELLAR_PRECISION)
    }
}

async function getOpenPositions(request, response) {
    let addr = request.params.accountId
    let account = await Account.objects.get({ address: addr })
    if (!account) {
        throw new ServerError("Can't find account", "not_found")
    }

    let positions = await Position.objects.filter({ account: account, type: "open", openAmount__gt:0, orderBy: "-time" })

    let aggMap = {}
    let aggs = []
    for (let p of positions) {
        if (!aggMap[p.boughtAsset]) {
            aggMap[p.boughtAsset] = new OpenPositionAgg(p.boughtAsset)
            aggs.push(aggMap[p.boughtAsset])
        }
        aggMap[p.boughtAsset].addPosition(p)
    }

    for (let agg of aggs) {
        agg.round(STELLAR_PRECISION)
    }

    aggs.sort(function (a, b) {
        return b.lastTime - a.lastTime
    })

    response.json(aggs)
}

async function getAggs(request, response) {
    let end = await AccountSummary.objects.get({orderBy: "-date", account:request.account.id})
    if (!end) {
        response.json([])
        return
    }

    let dayAggMap = await updateAggs(end)

    let out = []
    for (let day in dayAggMap) {
        let agg = dayAggMap[day]
        agg.days = day
        out.push(agg)
    }

    out.sort(function (a, b) {
        return a.day - b.day
    })

    response.json(out)
}

let balanceResolver = new AssetBalanceResolver()

async function getValue(summaries) {
    let requestSummaries = []
    for (let s of summaries) {
        if (s.valueXlm) {
            continue
        }

        requestSummaries.push(s)
    }

    await balanceResolver.getValueXlm(requestSummaries)
    // save these
}

async function getYearSummary(account) {
    let start = moment().subtract(1, "year")    
    return await AccountSummary.objects.filter({ orderBy: "date", account: account, date__gte: start })    
}

async function getValuePlot(request, response) {
    response.json([])
    return

    log.info("getting value plot")
    let ss = await getYearSummary(request.account)
    log.info("summary length:" + ss.length)
    
    if (ss.length == 0)
    {
        response.json([])
        return
    }

    await getValue(ss)

    let out = []
    for (let s of ss) {
        out.push([+s.date, s.valueXlm])
    }

    response.json(out)
}

async function getProfitsPlot(request, response) {
    let ss = await getYearSummary(request.account)
    if (ss.length == 0) {
        response.json([])
        return
    }

    let out = []    
    for (let s of ss) {
        out.push([+s.date, s.totalProfits])
    }

    response.json(out)
}

class ServerError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code
        this.name = this.constructor.name;
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, this.constructor);
        } else {
            this.stack = (new Error(message)).stack;
        }
    }
}

function controller(fn) {
    return async function (request, response) {
        try {
            // note: await necessary to catch err
            return await fn(request, response)
        } catch (error) {
            log.error(error)
            log.info("caught error")

            if (error instanceof ServerError) {
                response.status(400).json({ error: error.code || "unknown" })
            } else {
                log.info("sending 500")                
                response.status(500).json()
            }
        }
    }
}

async function accountById(request, response, next, accountId) {
    let a = await Account.objects.get({ address: request.params.accountId })
    if (!a) {
        log.error("account not found")
        return response.status(404).send({})
    }
    request.account = a
    next()
}

module.exports.registerRoutes = function (app) {
    app.route('/api/leaders/:type')
        .get(controller(getLeaders))
    
    app.route('/api/accounts/:accountId/closed')
        .get(controller(getClosedPositions))
    
    app.route('/api/accounts/:accountId/open')
        .get(controller(getOpenPositions))

    app.route('/api/accounts/:accountId/aggs')
        .get(controller(getAggs))

    app.route('/api/accounts/:accountId/plot/profits')
        .get(controller(getProfitsPlot))

    app.route('/api/accounts/:accountId/plot/value')
        .get(controller(getValuePlot))

    app.route('/api/accounts/:accountId')
        .delete(controller(deleteAccount))

    app.route('/api/accounts')
        .post(controller(createAccount))
        .get(controller(listAccounts))

    app.param('accountId', accountById);

}