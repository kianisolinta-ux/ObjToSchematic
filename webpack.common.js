const path = require('path');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
    entry: './src/main.ts',
    plugins: [
        new NodePolyfillPlugin(),
        new HtmlWebpackPlugin({
            template: './template.html',
            favicon: './res/static/icon.ico',
        }),
    ],
    module: {
        rules: [
            {
                test: /\.worker.ts$/,
                use: [
                    {
                        loader: 'worker-loader',
                        options: {
                            inline: 'fallback',
                        },
                    },
                    {
                        loader: 'ts-loader',
                        options: {
                            transpileOnly: true,
                        },
                    },
                ],
            },
            {
                test: /\.css$/i,
                use: ['style-loader', 'css-loader'],
                exclude: /node_modules/,
            },
            {
                test: /\.vs|fs|atlas$/,
                use: 'raw-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.png$/,
                type: 'javascript/auto',
                use: [
                    {
                        loader: 'file-loader',
                        options: {
                            esModule: false,
                        },
                    },
                ],
                exclude: /node_modules/,
            },
            {
                test: /\.tsx?$/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            transpileOnly: true,
                        },
                    },
                ],
                exclude: /node_modules/,
            },
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, './webpack'),
        publicPath: '',
    },
};
