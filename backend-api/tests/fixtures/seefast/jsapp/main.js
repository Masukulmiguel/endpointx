// Author-written fixture mini-app (Task 8) — static-analysis input only.
// Never executed by the test suite; the engine reads it as data.
const path = require('path');
const loadAddon = require('node-gyp-build');
const { fingerprint } = require('./utils');

const addon = loadAddon(path.join(__dirname, 'prebuilds'));

module.exports = { addon, fingerprint };
