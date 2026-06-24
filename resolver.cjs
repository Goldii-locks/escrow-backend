const fs = require('fs');
const pathModule = require('path');

module.exports = function (path, options) {
  // Catch relative imports ending in .js
  if ((path.startsWith("./") || path.startsWith("../")) && path.endsWith(".js")) {
    const targetTsPath = path.replace(/\.js$/, ".ts");
    const absoluteTsPath = pathModule.resolve(options.basedir, targetTsPath);

    // Physically check if the .ts file exists at this location
    if (fs.existsSync(absoluteTsPath)) {
      return options.defaultResolver(absoluteTsPath, options);
    }
  }

  // Fall back to Jest's default resolver for everything else
  return options.defaultResolver(path, options);
};