const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const path = require('path');

module.exports = merge(common, {
    mode: 'development',
    devtool: 'eval-source-map',
    devServer: {
        host: '0.0.0.0',
        port: 3000,
        allowedHosts: 'all',
        static: {
            directory: path.join(__dirname, './webpack'),
        },
        hot: false,
        liveReload: false,
        client: false,
        webSocketServer: false,
    },
});
