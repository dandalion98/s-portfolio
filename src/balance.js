let StellarSdk = require('stellar-sdk');

/*
 * Responsible for tracking and caching the price history
 * for a Stellar asset through a date range. Supports incrementally
 * expanding the date range as new dates are needed.
 */
class AssetPriceHistory {
    constructor(ticker, stellarServer) {
        this.stellarServer = stellarServer
        this.ticker = ticker
        let t = ticker.split("-")
        this.stellarAsset = new StellarSdk.Asset(t[0], t[1])
        this.datePriceMap = {}
    }

    getMissingDateRange(dateRange) {
        let start, end

        if (!this.earliestDate || +dateRange[0] < +this.earliestDate) {
            start = dateRange[0]
        }

        if (!this.latestDate || +dateRange[1] > +this.latestDate) {
            end = dateRange[1]
        }

        if (!start && !end) {
            // no missing ranges
            return null
        } else if (!start) {
            start = this.latestDate
        } else if (!end) {
            end = this.earliestDate
        }

        // add some padding in case there's no trade on certain days
        start = moment(start).subtract(30, "days").toDate()
        end = moment(end).add(3, "days").toDate()

        return [start, end]
    }

    getPrice(date) {
        let out = this.datePriceMap[+date]
        if (undefined == out) {
            log.error(`No price for ${this.ticker} on ${date}`)
            return 0
        }

        return out
    }

    async getPricesForRange(dateRange) {
        let loggr = log4js.getLogger('value')
        loggr.debug("getting prices for range", dateRange)

        let missingRange = this.getMissingDateRange(dateRange)
        if (!missingRange) {
            return
        }

        let startDate = +missingRange[0]
        let endDate = +missingRange[1]
        loggr.debug("missing range", missingRange)
        loggr.debug(`startDate=${startDate} endDate=${endDate}`)

        // TODO: handle handle next
        var trades = this.stellarServer.tradeAggregation(this.stellarAsset, StellarSdk.Asset.native(), startDate, endDate, 86400000).limit(200).order('desc')
        let data = await trades.call()
        let records = data.records

        let nextExpectedDate = moment(+data.records[records.length - 1].timestamp).startOf('day')
        let prevPrice
        for (let i = records.length - 1; i >= 0; i--) {
            let record = records[i]
            let recordDate = moment(+record.timestamp).startOf('day')

            while (+nextExpectedDate != recordDate) {
                loggr.debug(`filling ts=${nextExpectedDate} price=${prevPrice}`)
                this.datePriceMap[+nextExpectedDate] = prevPrice
                nextExpectedDate = nextExpectedDate.add(1, 'day')
            }

            let price = +record.close

            if (!this.earliestDate || +recordDate < +this.earliestDate) {
                this.earliestDate = recordDate
            }

            if (!this.latestDate || +recordDate > +this.latestDate) {
                this.latestDate = recordDate
            }

            this.datePriceMap[+recordDate] = price
            loggr.debug(`added ts=${recordDate} price=${price}`)
            nextExpectedDate = recordDate.add(1, 'day')
            prevPrice = price
        }
    }
}

module.exports.AssetPriceHistory = AssetPriceHistory

/*
 * Responsible for resolving balances for diverse assets into 
 * estimate XLM value based on price history.
 */
class AssetBalanceResolver {
    constructor() {
        this.assetPriceHistoryMap = {}
    }

    async getValueXlm(summaries) {
        let loggr = log4js.getLogger('value')
        loggr.debug("getting value")

        let earliestSumary = summaries[0]
        let latestSumary = summaries[summaries.length - 1]
        let dateRange = [earliestSumary.date, latestSumary.date]
        loggr.debug("date range", dateRange)

        let assetsToResolve = new Set()
        for (let s of summaries) {
            if (typeof s.endBalance === 'string') {
                s.endBalance = JSON.parse(s.endBalance)

                for (let ticker in s.endBalance) {
                    if (ticker != 'native' && s.endBalance[ticker] > 0) {
                        assetsToResolve.add(ticker)
                    }
                }
            }
        }

        assetsToResolve = Array.from(assetsToResolve)
        loggr.debug("assets to resolve", assetsToResolve)

        for (let asset of assetsToResolve) {
            if (!this.assetPriceHistoryMap[asset]) {
                loggr.debug("creating price history for asset", asset)
                this.assetPriceHistoryMap[asset] = new AssetPriceHistory(asset, server)
            }

            await this.assetPriceHistoryMap[asset].getPricesForRange(dateRange)
        }

        let today = moment().startOf("day")
        for (let s of summaries) {
            if (+moment(s.date).startOf("day") == +today) {
                // no close price yet
                continue
            }

            let value = 0
            for (let asset in s.endBalance) {
                if (asset == 'native') {
                    value += s.endBalance.native
                } else {
                    if (!this.assetPriceHistoryMap[asset]) {
                        log.error("Could not find asset: " + asset)
                    } else {
                        value += s.endBalance[asset] * this.assetPriceHistoryMap[asset].getPrice(s.date)
                    }
                }
            }
            s.valueXlm = value
        }
    }
}

module.exports.AssetBalanceResolver = AssetBalanceResolver
