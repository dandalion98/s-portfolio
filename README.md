# stellar-portfolio
A portfolio management, aggregator, and leaderboard service for Stellar.

This service analyze Stellar accounts for account changes and trade positions. In computing profitability, service will attempt to account for credits and debits, to provide a best effort ROI computation. It's capable of tracking profits for as set of Stellar accounts, as well as compute leaderboards. Supports a REST API interface to query positions, account value, metrics, and leader board.

Service will periodically import new effects to keep account statistics up to date.

# REST API
#### Create account and import history
`POST /api/accounts`

```{"address": "<account_address>"}```

#### List all accounts
`GET /api/accounts`

#### Get metrics for portfolio leaders (ranked by ROI) aggregated a given timer period
`GET /api/leaders/:timePeriod`

`timePeriod is either "last7", "last30", "last90", or "last365"`

#### Get buy positions for an account
`GET /api/accounts/:accountId/open`

#### Get sold positions for an account
`GET /api/accounts/:accountId/closed`

#### Get profitability statistics for an account
`GET /api/accounts/:accountId/aggs`

#### Aggregate account profit plot (by day)
`GET /api/accounts/:accountId/plot/profits`

#### Aggregate account value plot (by day)
`GET /api/accounts/:accountId/plot/value`

# Configuration
Default configuration is stored `config/env/default.js`. Create `config/env/development.js` to override configuration specific to dev environment, and `config/env/production.js` for production environment.

This project uses pg-orm, a Postgres ORM for Javascript, which in turn uses node-postgres. Postgres configuration must be defined via the configuration `db` attribute.

This project also uses log4js. log4js configuration can be optionally defined via the config `logging` attribute.

# Usage

### Run in dev env
`gulp`

### Run in production env
`gulp prod`

# Installation
*git submodule init .*

*git submodule update --remote*

*npm install*

# Docker
Use provided Dockerfile to build a Docker image for this service.
