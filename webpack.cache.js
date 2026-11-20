const path = require('path')
const { initAssetCache } = require('@vercel/webpack-asset-relocator-loader')

// Zettlr-LYH: The development build is started anew for every launch, and
// compiling everything from scratch takes minutes. A persistent filesystem
// cache (in node_modules/.cache/webpack) lets later launches rebuild only the
// files that changed. The cache is dropped automatically whenever one of the
// build configuration files changes.
function persistentCache (configFile) {
  return {
    type: 'filesystem',
    buildDependencies: {
      config: [
        configFile,
        __filename,
        path.resolve(__dirname, 'webpack.rules.js'),
        path.resolve(__dirname, 'forge.config.js')
      ]
    }
  }
}

// The asset relocator loader adds the runtime line that sets
// `__webpack_require__.ab` (the folder of the relocated native modules) only
// while it processes a module. When every module comes from the cache, the
// loader never runs, the line is missing, and native modules fail to load
// ("undefinedbuild/Release/....node"). initAssetCache is the loader's own entry
// point for cached builds; it installs the runtime line for each compilation.
// Only the main process needs it: the renderer bundles never use the line, and
// sandboxed preload scripts have no __dirname to evaluate it with.
class AssetRelocatorCachePlugin {
  apply (compiler) {
    compiler.hooks.compilation.tap('AssetRelocatorCachePlugin', compilation => {
      initAssetCache(compilation, 'native_modules')
    })
  }
}

module.exports = { persistentCache, AssetRelocatorCachePlugin }
