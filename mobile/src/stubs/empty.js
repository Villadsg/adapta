// Browser stub for Node-only modules (duckdb, fs, path) that the shared engine
// references but never actually uses on the mobile path. Exporting an empty
// object keeps the bundler happy without pulling in native code.
module.exports = {};
