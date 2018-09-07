var _ = require('lodash'),
    stellarPay = require("stellar-pay"),
    log = require('tracer').colorConsole(),
    StellarSdk = require('stellar-sdk'),
    stellarServer = stellarPay.liveServer(),
    roundTo = require('round-to'),
    pgo = require('pg-orm'),
    tx = pgo.tx,
    Account = pgo.model("Account"),    
    Position = pgo.model("Position"),
    AccountSummary = pgo.model("AccountSummary"),
    AccountAggregation = pgo.model("AccountAggregation"),
    moment = require('moment'),    
    fs = require('fs'),
    log4js = require('log4js'),
    AssetBalanceResolver = require("./balance").AssetBalanceResolver,
    config = require("../config/config"),
    portfolio = require("./portfolio"),    
    AccountEffects = portfolio.AccountEffects,
    AccountSummarizer = portfolio.AccountSummarizer

require('moment-round');

var logger = log4js.getLogger('main');
// logger.setLevel('DEBUG');

var server = new StellarSdk.Server(config.stellarServer); 

stellarServer = stellarPay.liveServer()

var updateAccountLogger = log4js.getLogger('updateAccount');
var aggsLogger = log4js.getLogger('aggs');

async function createTestAccount() {
    if (!config.testAccount) {
        return
    }

    let a = await Account.objects.get({ address: config.testAccount})
    if (!a) {
        a = new Account({ address: config.testAccount})
        await a.save()
    }
    return a
}

async function reimportAccount(address) {
    log.info("Attempting to reimport account: " + address)    
    let a = await Account.objects.get({ address: address })
    if (!a) {
        log.error("Skipping due to account not found")
        return
    }

    await a.delete()

    a.id = null
    await a.save()
    await syncAccounts([a])    
}

module.exports.reimportAccount = reimportAccount

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

async function testTemp() {
    let effects = require("../samples/positions.json")
    let map = {}
    log.info("got " + effects.length)
    for (let e of effects) {
        if (map[e.tradeId]) {
            log.warn("dupe: " + e.tradeId)
        }

        map[e.tradeId] = true
    }
}

module.exports.test = async function() {
    // testTemp()
    // return

    let account = await createTestAccount()

    // let p = await Position.objects.filter({ tradeId:"0083073798605135873-0000000001"})
    // log.error("ddx p")
    // console.dir(p)

    // // let today = moment().startOf('day')
    // let as = await AccountSummary.objects.filter({account: account, orderBy:"-date", limit:5})
    // console.dir(as)

    // let smp = checkPositions()
    // let sme = checkEffects()
    // for (let k in sme) {
    //     if (smp[k] != sme[k]) {
    //         log.error(`msimatch ${k} ${smp[k]} ${sme[k]}`)
    //     }
    // }

    // await syncAccounts([account])

    // await tx(async pclient => {
    //     await updateAccount(account, pclient, null, {
    //         noSave: true,
    //         forceImport: true,
    //         // startId: "0083073510842314753-0000000001"
    //     })
    // })    
}

async function checkHealth(request, response) {    
    response.json({status: "ok"})
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

    let outAccount = await tx(async pclient => {
        let a = new Account(data)
        await a.save(pclient)

        // TODO: handle failures
        await updateAccount(a, pclient, data.effects)
        return a
    })

    response.json(outAccount)
}

async function deleteAccount(request, response) {
    let account = request.account
    await account.delete()
    response.json({})
}

function truncateEffects(effects, startId) {
    if (!startId) {
        throw new Error("No start ID provided")
    }

    // log.info("truncating effects: start="+startId)
    let out = []
    let foundStart = false
    for (let e of effects) {
        // log.info(e.id)
        if (e.id == startId) {
            foundStart = true
        }

        if (foundStart) {
            out.push(e)
        }
    }

    if (!foundStart) {
        throw new Error("Did not find start effect: " + startId)
    }

    return out
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

async function syncAccounts(accounts) {
    let startTime = moment().round(30, "minutes")
    updateAccountLogger.debug("BEGIN SYNCING ACCOUNTS for interval: " + startTime)
    if (!accounts) {
        let UPDATE_MAX_COUNT = 15
        accounts = await Account.objects.filter({ lastUpdateTime__isnull: true, limit: UPDATE_MAX_COUNT })

        if (!accounts || !accounts.length) {
            accounts = await Account.objects.filter({ lastUpdateTime__lt: startTime, limit: UPDATE_MAX_COUNT })
        }
    }

    for (let account of accounts) {        
        updateAccountLogger.debug("SYNCING " + account.address)        
        await tx(async pclient => {
            account = await Account.objects.get({ id: account.id, lock: true })
            if (!account) {
                updateAccountLogger.warn("Failed to lock")
                return null
            }
            
            await updateAccount(account, pclient)
            await updateAggsForAccount(account, pclient)
        })
    }
}
module.exports.syncAccounts = syncAccounts

async function updateAggsForAccount(account, pclient) {
    aggsLogger.debug("updating account: "+account.address)
    let end = await AccountSummary.objects.get({ orderBy: "-date", account: account })
    if (!end) {
        aggsLogger.debug("no summaries found")
        return
    }

    await updateAggs(end)
}

async function updateAccount(account, pclient, effects, opts) {
    let DONT_SAVE = false

    if (opts && opts.noSave) {
        updateAccountLogger.debug("force dbugging")
        DONT_SAVE = true
    }

    // await pgo.truncateAll()
    updateAccountLogger.debug("checking account for update", account)
    if (effects) {
        updateAccountLogger.debug("effects provide", effects.length)            
    }

    let latestDayRecord = await AccountSummary.objects.get({account:account, orderBy:"-date"})
    let latestEffectId = latestDayRecord ? latestDayRecord.lastEffectId : null
    updateAccountLogger.debug("checking latestDayRecord", latestDayRecord)

    let stellarAccount = stellarServer.getAccount({address: account.address})
    let balance = await stellarAccount.getBalanceFull()
    updateAccountLogger.debug("balance", balance)     

    if (opts && opts.forceImport && latestEffectId) {
        updateAccountLogger.debug("forcing import effects")
        latestEffectId = null
    }

    updateAccountLogger.debug("---------------------------------------------------------------")
    updateAccountLogger.debug("getting effects latestTx="+latestEffectId)
    updateAccountLogger.debug("---------------------------------------------------------------")  
    if (!effects) { 
        effects = await stellarAccount.listEffects(latestEffectId)
    } else {
        effects = filterNewEffects(effects, latestEffectId)
    }

    if (opts && opts.startId) {
        effects = truncateEffects(effects, opts.startId)
    }

    updateAccountLogger.debug("got " + effects.length + " effects")

    // var json = JSON.stringify(b, null, 4);
    // fs.writeFileSync("./effects.json", json, 'utf8');

    updateAccountLogger.debug("---------------------------------------------------------------")
    updateAccountLogger.debug("parsing account effects")
    updateAccountLogger.debug("---------------------------------------------------------------") 
    // let effects = require("../effects.json")

    let ae = new AccountEffects(account, effects)
    ae.clean()    
    ae.computeBalance(balance)

    writeDebug(ae.effects, "e2.json")    

    // return

    updateAccountLogger.debug("---------------------------------------------------------------")
    updateAccountLogger.debug("parsing positions")
    updateAccountLogger.debug("---------------------------------------------------------------") 
    let existingOpenPositions = await Position.objects.filter({ account: account, type:"open", openAmount__gt:0, orderBy:"-time"})
    updateAccountLogger.debug("existing open positions", existingOpenPositions)

    let positions = ae.getPositions(existingOpenPositions)
    
    writeDebug(positions, "positions.json")

    updateAccountLogger.debug("---------------------------------------------------------------")
    updateAccountLogger.debug("creating account summary")
    updateAccountLogger.debug("---------------------------------------------------------------") 
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
    writeDebug(dmo, "weekmap.json")

    if (DONT_SAVE) {
        return
    }
    
    await Position.objects.save(positions, pclient)

    let asr = as.getRecords()
    for (let r of asr) {
        r.account = account
    }
    await AccountSummary.objects.save(asr, pclient)

    account.lastUpdateTime = new Date()
    await account.save(pclient)

    // log.info('get start')
    // let startOfMonth = moment().startOf('month').toDate()
    // let start = await AccountSummary.objects.get({ date__gte: startOfMonth, orderBy: "date"})
    // console.dir(start)

    // can't do aggs until we save
    // let end = await AccountSummary.objects.get({ date__lte: moment().toDate(), orderBy:"-date" })
    // console.dir(end)    

    // let roi = end.getRoi(start) 
    // log.info("ROI="+roi)

    // let start0 = await AccountSummary.objects.get({ orderBy: "date" })
    // roi = end.getRoi(start0)
    // log.info("ROI0=" + roi)

    // await updateAggs(end)
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
        // console.dir(agg)
    }

    return outAggs
}

function writeDebug(obj, fname) {
    try {
        if (config.env == "dev") {
            // log.info("ddx writing len: " + obj.length)            
            var json = JSON.stringify(obj, null, 4);
            fs.writeFileSync("./samples/"+fname, json, 'utf8'); 
        }
    } catch (error) {
        log.error(error)
    }
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

    let positions = await Position.objects.filter({ account: account, type: "close", orderBy: "-time", openTradeId__isnull: false})

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

async function queryAggs(request, response) {
    let body = request.body
    let duration = body.duration || "last7"
    let addresses = body.addresses

    aggsLogger.debug(`Querying aggs`, body)

    if (!addresses || !addresses.length) {
        throw new ServerError("bad request: no addresses provided", "bad_request")
    }

    let aggs = await AccountAggregation.objects.filter({ account__address__in: addresses, fkReturn: ["account__address"], type:duration, orderBy:"-roi"})
    response.json(aggs)
}

async function getAggsForAccount(request, response) {
    aggsLogger.debug("Getting aggs for account: "+request.account.address)
    let end = await AccountSummary.objects.get({orderBy: "-date", account:request.account.id})
    if (!end) {
        aggsLogger.debug("no summaries found")
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

let balanceResolver = new AssetBalanceResolver(server)

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
    
    app.route('/api/aggs')
        .post(controller(queryAggs))

    app.route('/api/accounts/:accountId/closed')
        .get(controller(getClosedPositions))
    
    app.route('/api/accounts/:accountId/open')
        .get(controller(getOpenPositions))

    app.route('/api/accounts/:accountId/aggs')
        .get(controller(getAggsForAccount))

    app.route('/api/accounts/:accountId/plot/profits')
        .get(controller(getProfitsPlot))

    app.route('/api/accounts/:accountId/plot/value')
        .get(controller(getValuePlot))

    app.route('/api/accounts/:accountId')
        .delete(controller(deleteAccount))

    app.route('/api/accounts')
        .post(controller(createAccount))
        .get(controller(listAccounts))

    app.route('')    
        .get(controller(checkHealth))

    app.param('accountId', accountById);

}