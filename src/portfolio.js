var _ = require('lodash'),
    log = require('tracer').colorConsole(),
    roundTo = require('round-to'),
    pgo = require('pg-orm'),
    Account = pgo.model("Account"),
    Position = pgo.model("Position"),
    AccountSummary = pgo.model("AccountSummary"),
    AccountAggregation = pgo.model("AccountAggregation"),
    moment = require('moment'),
    fs = require('fs'),
    log4js = require('log4js');

var logger = log4js.getLogger('main');
// logger.setLevel('DEBUG');

let NUMERICAL_FIELDS = ["sold_amount", "bought_amount", "amount"]

/*
 * Parses an account effect from Horizon.
 */
class AccountEffect {
    constructor(account, data) {
        Object.assign(this, data)

        this.account = account

        delete this._links

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
        p.boughtAmount = roundTo(this.bought_amount, 7)
        p.soldAsset = this.sold_asset
        p.soldAmount = roundTo(this.sold_amount, 7)
        // TOOD: map to account obj
        p.account = this.account
        p.time = this.time.toDate()
        // TODO: parse time

        if (p.boughtAsset != "native") {
            p.openAmount = p.boughtAmount
        }

        if (p.soldAsset == "native") {
            // open opsition
            p.boughtPrice = roundTo(p.soldAmount / p.boughtAmount, 7)
            p.type = "open"
        } else if (p.boughtAsset == "native") {
            // close position
            p.soldPrice = roundTo(p.boughtAmount / p.soldAmount, 7)
            p.type = "close"
        } else {
            p.type = "convert"
        }

        return p
    }

    isMergeableWith(other) {
        return (this.created_at == other.created_at && this.sold_asset_code == other.sold_asset_code && this.bought_asset_code == other.bought_asset_code)
    }

    mergeWith(other) {
        this.sold_amount += other.sold_amount
        this.bought_amount += other.bought_amount
    }
}

module.exports.AccountEffect = AccountEffect

/*
 * Responsible for tracking open positions and matching against
 * closed positions.
 */
class PositionMatcher {
    constructor() {
        this.openMap = {}
    }

    addOpenPosition(position) {
        let pc = position.boughtAsset
        if (!this.openMap[pc]) {
            this.openMap[pc] = []
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
        logger.debug("looking for matches")
        for (let openPosition of this.openMap[rpc]) {
            if (!openPosition.openAmount) {
                continue
            }

            logger.debug("evaluating ", openPosition)
            if (openPosition.openAmount == closePosition.soldAmount) {
                logger.debug("found exact match")
                exactMatch = openPosition
                break
            }

            if (openPosition.openAmount > 0 && multiSum < closePosition.soldAmount) {
                logger.debug("found subset match")
                multiMatches.push(openPosition)
                multiSum += openPosition.openAmount
            }

            multiSum = roundTo(multiSum, 7)
        }

        logger.debug(`finished eval ${multiSum} ${closePosition.soldAmount}`)

        if (exactMatch) {
            return [exactMatch]
        } else if (multiSum >= closePosition.soldAmount) {
            return multiMatches
        } else {
            return null
        }
    }
}
module.exports.PositionMatcher = PositionMatcher

/*
 * Represents a sequence of Stellar account effects in chronological
 * order. Responsible for tracking balance alterations through credit, debits,
 * and trades, and for tracking trade positions.
 */
class AccountEffects {
    constructor(account, data) {
        this.effects = []
        for (let t of data) {
            this.effects.push(new AccountEffect(account, t))
        }
    }

    parsePositions() {
        let positions = []
        for (let e of this.effects) {
            if (e.type != "trade") {
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
        for (let i = allPositions.length - 1; i >= 0; i--) {
            let position = allPositions[i]
            logger.debug(`parsing position ${i}`, position)

            if (position.isOpenPosition()) {
                logger.debug("is open")
                matcher.addOpenPosition(position)
                finalPositions.unshift(position)
            } else {
                logger.debug("not open")
                let openPositions = matcher.match(position)
                logger.debug("matched open positions", openPositions)

                if (!openPositions) {
                    console.dir(position)
                    logger.error("Failed to match open position!")
                    position.type == "close_unk"
                    finalPositions.unshift(position)
                } else {
                    let closePositions = position.split(openPositions)
                    logger.debug("split close positions len=" + closePositions.length, closePositions)
                    for (let j = 0; j < openPositions.length; j++) {
                        closePositions[j].match(openPositions[j])
                        finalPositions.unshift(closePositions[j])
                    }
                }
            }
        }

        return finalPositions
    }

    clean() {
        let out = []
        let txEffectsMap = {}
        for (let effect of this.effects) {
            let effectsSameTx = txEffectsMap[effect.created_at]

            if (effectsSameTx) {
                let merged = false

                for (let checkedEffect of effectsSameTx) {
                    if (checkedEffect.isMergeableWith(effect)) {
                        checkedEffect.mergeWith(effect)
                        merged = true
                        break
                    }
                }

                if (!merged) {
                    effectsSameTx.push(effect)
                    out.push(effect)
                }
            } else {
                txEffectsMap[effect.created_at] = [effect]
                out.push(effect)
            }
        }

        this.effects = out
    }

    // Note: computed balance will differ very slightly from
    // real balance because we have no insights into fees (e.g. failed tx)
    computeBalance(endBalance) {
        endBalance = Object.assign({}, endBalance)
        if (!this.effects.length) {
            return
        }

        for (let effect of this.effects) {
            effect.endBalance = Object.assign({}, endBalance)

            if (effect.type == 'trade') {
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

module.exports.AccountEffects = AccountEffects

/*
 * Responsible for generating daily summaries (AccountSummary) from
 * effects. Supports incrementally updating an existing summary from
 * new effects.
 */
class AccountSummarizer {
    constructor(latestDayRecord) {
        // maps a date (representing 1 day) to an AccountSummary
        this.dateMap = {}
        this.latestDayRecord = latestDayRecord
    }

    getRecords() {
        return Object.values(this.dateMap)
    }

    ensureDateExists(dt) {
        let dtk = dt.toISOString()
        if (!this.dateMap[dtk]) {
            this.dateMap[dtk] = new AccountSummary({ date: dt.toDate(), profits: 0, trades: 0, winningTrades: 0 })
        }
        return this.dateMap[dtk]
    }

    // Assuming parsing effects backwards in date (from most recent to least recent)
    // This only parses new effects
    // Positions must have been already added at this point
    addEffects(effects) {
        logger.debug("Processing effects")
        let lastEffectPerDateMap = {}
        let dateList = []

        for (let e of effects) {
            let ws = e.time.startOf('day')
            let wsk = ws.toISOString()

            let daySummary = this.ensureDateExists(ws)

            if (!lastEffectPerDateMap[wsk]) {
                // This effect is the last for the day
                lastEffectPerDateMap[wsk] = e
                dateList.unshift(daySummary)

                daySummary.lastEffectId = e.id
                daySummary.endBalance = JSON.stringify(e.endBalance)
            }

            if (e.type == "account_debited") {
                daySummary.debits = (daySummary.debits || 0) + e.amount
            } else if (e.type == "account_credited") {
                daySummary.credits = (daySummary.credits || 0) + e.amount
            } // trades taken care of by positions
        }

        // dateList is ordered chronologically
        // 3 cases:
        // 1. No previous day record (all effects new)
        // 2. New effects with an existing day record (latestDayRecord == same day)
        // 3. New effects without an existing day record (latestDayRecord == some previous day)
        let lastDateRecord
        if (this.latestDayRecord) {
            lastDateRecord = this.latestDayRecord
        } else {
            lastDateRecord = { totalCredits: 0, totalDebits: 0, totalProfits: 0, totalTrades: 0, totalWinningTrades: 0 }
        }
        logger.debug("saved lastDayRecord", this.latestDayRecord)

        for (let i = 0; i < dateList.length; i++) {
            let dayRecord = dateList[i]
            // logger.debug("merging totals")
            // logger.debug("dayRecord", dayRecord)
            dayRecord.updateTotals(lastDateRecord)
            lastDateRecord = dayRecord
        }
    }

    addPositions(pos) {
        for (let i = pos.length - 1; i >= 0; i--) {
            let p = pos[i]

            // only account for new positions
            if (p.id) {
                continue
            }

            if (!p.isClosePosition()) {
                continue
            }

            logger.debug("ddx close posit", p)

            let ws = new moment(p.time).startOf('day')
            let record = this.ensureDateExists(ws)

            record.trades++
            if (+p.profits > 0) {
                record.winningTrades++
            }

            record.profits += p.profits
        }
    }
}
module.exports.AccountSummarizer = AccountSummarizer