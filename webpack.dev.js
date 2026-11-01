const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const path = require('path');

module.exports = merge(common, {
    mode: 'development',
    devtool: 'eval-cheap-module-source-map',
    devServer: {
        host: '0.0.0.0',
        port: 3000,
        allowedHosts: 'all',
        headers: {
            'Access-Control-Allow-Origin': '*',
        },
        static: false,
        hot: false,
        liveReload: false,
        client: false,
        webSocketServer: false,
    },
});
