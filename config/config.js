var _ = require('lodash'),
    chalk = require('chalk'),
    glob = require('glob'),
    fs = require('fs'),
    path = require('path');

function init() {
    let defaultConfig = require(path.join(process.cwd(), 'config/env/default'));
    let environmentConfig = require(path.join(process.cwd(), 'config/env/', process.env.NODE_ENV)) || {};
    var config = _.merge(defaultConfig, environmentConfig);
    return config
}

module.exports = init();
