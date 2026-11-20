const rules = require('./webpack.rules')
const path = require('path')

const CopyWebpackPlugin = require('copy-webpack-plugin')
const { VueLoaderPlugin } = require('vue-loader')
const { DefinePlugin } = require('webpack')
// The renderer bundles never load relocated native modules, so unlike the main
// process they need no AssetRelocatorCachePlugin
const { persistentCache } = require('./webpack.cache')

// Zettlr-LYH R59: pdf.js loads its worker script and data files at run time
// by URL. They are copied unchanged into the folder pdfjs/ of the renderer
// output, next to the window folders, where the PDF viewer looks for them
// (source/win-main/file-viewers/pdf-viewer/pdfjs.ts). The files are already
// minified, so the minimizer skips them.
const pdfjsDistribution = path.resolve(__dirname, 'node_modules/pdfjs-dist')
const pdfjsAssetInfo = { minimized: true }

const plugins = [
  // Apply webpack rules to the corresponding language blocks in .vue files
  new VueLoaderPlugin(),

  new CopyWebpackPlugin({
    patterns: [
      { from: path.join(pdfjsDistribution, 'build/pdf.worker.min.mjs'), to: 'pdfjs/pdf.worker.min.mjs', info: pdfjsAssetInfo },
      { from: path.join(pdfjsDistribution, 'cmaps'), to: 'pdfjs/cmaps', info: pdfjsAssetInfo },
      { from: path.join(pdfjsDistribution, 'standard_fonts'), to: 'pdfjs/standard_fonts', info: pdfjsAssetInfo },
      {
        from: path.join(pdfjsDistribution, 'wasm'),
        to: 'pdfjs/wasm',
        info: pdfjsAssetInfo,
        // QuickJS only runs the JavaScript embedded in PDFs, which the viewer
        // does not enable
        globOptions: { ignore: ['**/quickjs-eval.*'] }
      },
      { from: path.join(pdfjsDistribution, 'iccs'), to: 'pdfjs/iccs', info: pdfjsAssetInfo },
      // Icons of PDF annotations such as notes and attachments (the viewer's
      // imageResourcesPath)
      { from: path.join(pdfjsDistribution, 'web/images'), to: 'pdfjs/images', info: pdfjsAssetInfo }
    ]
  }),

  // Set a few Vue 3 options; see: http://link.vuejs.org/feature-flags
  new DefinePlugin({
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false, // New in Vue 3.4
    // Quote from the docs: "Note that because the plugin does a direct text
    // replacement, the value given to it must include actual quotes inside of
    // the string itself. Typically, this is done either with alternate quotes,
    // such as '"production"', or by using JSON.stringify('production')."
    __GIT_COMMIT_HASH__: JSON.stringify(process.env.GIT_COMMIT_HASH),
    __BUILD_DATE__: JSON.stringify((new Date()).toISOString()),
    __UPDATES_DISABLED__: JSON.stringify('1') // Zettlr-LYH requirement R95: never update from upstream Zettlr; see source/app/service-providers/updates/update-source.ts
  })
]

rules.push({
  test: /\.less$/,
  use: [{
    loader: 'style-loader' // Create style nodes from JS strings
  }, {
    loader: 'css-loader' // Translate CSS into JS string
  }, {
    loader: 'less-loader' // Compile Less to CSS
  }]
})

module.exports = {
  cache: persistentCache(__filename),
  module: { rules },
  // The following line of code serves two purposes: While we're in develop
  // (NODE_ENV = develop), emit source maps so we have an easy time finding the
  // origin of bugs or performance bottlenecks. But since source maps are a
  // whopping 60MB large at the time of writing (July 2021), we disable these
  // in production (i.e. when we ship to users). NOTE, however, that these env-
  // variables must be set, which we're doing using cross-env in package.json.
  devtool: (process.env.NODE_ENV === 'production') ? false : 'source-map',
  plugins,
  resolve: {
    extensions: [
      '.js', '.ts', '.jsx', '.tsx',
      '.css', '.less', '.vue'
    ],
    alias: {
      source: [path.resolve(__dirname, 'source')],
      '@common': [path.resolve(__dirname, 'source/common')],
      '@providers': [path.resolve(__dirname, 'source/app/service-providers')],
      '@dts': [path.resolve(__dirname, 'source/types')]
    },
    fallback: {
      // Don't polyfill these modules
      path: false,
      fs: false
    }
  }
}
