'use strict';
// Builds a standalone settings file that points every hook + the statusline at
// dump.js, for use with `claude --settings`. Touches no shared config.
const fs = require('fs'), path = require('path');
const probe = path.resolve(__dirname, 'dump.js').split(path.sep).join('/');
const EVENTS = ['PreToolUse','PostToolUse','Notification','UserPromptSubmit','Stop',
                'SubagentStop','PreCompact','SessionStart','SessionEnd'];
const MATCHED = new Set(['PreToolUse','PostToolUse','PreCompact','SessionStart','SessionEnd']);
const hooks = {};
for (const ev of EVENTS) {
  const e = { hooks: [{ type: 'command', command: 'node "' + probe + '" hook ' + ev, timeout: 5 }] };
  if (MATCHED.has(ev)) e.matcher = '*';
  hooks[ev] = [e];
}
const out = process.argv[2];
fs.writeFileSync(out, JSON.stringify({
  statusLine: { type: 'command', command: 'node "' + probe + '" statusline', padding: 0 },
  hooks
}, null, 2));
console.log('wrote', out);
