// @ts-check
'use strict';
/*
 * Pipeline: the app's read side of the plugin's task records. The rules (recovery,
 * config) are the plugin's own pure modules, required by relative path so the tab
 * cannot disagree with /sereno:ship. package.json build.files bundles them.
 */

const recovery = require('../plugin/bin/lib/recovery.js');
const config = require('../plugin/bin/lib/config.js');

module.exports = { recovery, config, decide: recovery.decide };
