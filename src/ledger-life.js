// @ts-check
'use strict';
/*
 * Ledger lifecycle decisions, kept out of main.js so the GUI-free suite can test
 * them. main.js and tools/serve.js are thin glue around these.
 */

const { openLedger } = require('./ledger.js');

const OPT_IN_MESSAGE = 'Keep a local spend history?';
const OPT_IN_DETAIL = 'Sereno will record request costs on this computer. No prompts or code are stored.';
const OPT_IN_BUTTONS = ['Yes', 'Not now'];

// "Clear history" confirmation. Cancel is both the default and the dismissal, so Enter and Escape never clear.
const CLEAR_MESSAGE = "Clear Sereno's history?";
const CLEAR_DETAIL = "Deletes all recorded spend, sessions and timelines from Sereno's database. Claude Code and your projects are not touched. This can't be undone.";
const CLEAR_BUTTONS = ['Clear history', 'Cancel'];
const CLEAR_DEFAULT_ID = 1;
const CLEAR_CANCEL_ID = 1;

/** The dialog options for the confirmation (main.js passes them to dialog.showMessageBox). */
function clearHistoryDialog() {
  return { type: 'warning', message: CLEAR_MESSAGE, detail: CLEAR_DETAIL, buttons: CLEAR_BUTTONS.slice(), defaultId: CLEAR_DEFAULT_ID, cancelId: CLEAR_CANCEL_ID, noLink: true };
}

/**
 * Maps the dialog's button index to the value to store. Dismissal (Escape,
 * closing the window) is neither answer: it stays null so we ask again next time.
 * @param {number} response
 * @returns {boolean|null}
 */
function optInAnswer(response) {
  if (response === 0) return true;
  if (response === 1) return false;
  return null;
}

/**
 * Opens the ledger only when the config says enabled === true. With null or
 * false nothing is opened, so no database file is ever created.
 * @param {{ ledger?: { enabled: boolean|null, retentionDays: number } }} cfg
 * @param {{ open?: Function, log?: (m: string) => void, error?: (m: string) => void }} [deps]
 * @returns {{ ledger: any, unavailable: boolean }}
 */
function startLedger(cfg, deps = {}) {
  const { open = openLedger, log = () => {}, error = () => {} } = deps;
  const l = (cfg && cfg.ledger) || { enabled: null, retentionDays: 90 };
  if (l.enabled !== true) {
    log('spend history off (' + (l.enabled === false ? 'disabled' : 'not asked yet') + ')');
    return { ledger: null, unavailable: false };
  }
  try {
    const ledger = open({ retentionDays: l.retentionDays });
    log('spend history on (' + (ledger && ledger.file ? ledger.file : 'sereno.db') + ')');
    return { ledger, unavailable: false };
  } catch (e) {
    error('spend history unavailable: ' + (e && e.message ? e.message : e));
    return { ledger: null, unavailable: true };
  }
}

module.exports = { CLEAR_MESSAGE, CLEAR_DETAIL, CLEAR_BUTTONS, clearHistoryDialog, OPT_IN_MESSAGE, OPT_IN_DETAIL, OPT_IN_BUTTONS, optInAnswer, startLedger };
