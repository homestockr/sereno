// @ts-check
'use strict';
/*
 * Local-time helpers for the spend views. Pure: no I/O, no requires.
 * Day boundaries are local midnight on this machine, computed with Date setters so
 * DST days are 23 or 25 hours long. Never use toISOString here (it is UTC).
 */

/** @param {number} n @param {number} [w] */
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** @param {Date} d local 'YYYY-MM-DD' */
const ymd = d => pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

/** @param {number} ms ms of local midnight for that instant */
function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** @param {number} ms @returns {{ day: string, since: number, until: number }} */
function dayBounds(ms) {
  const d = new Date(ms);
  const since = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const until = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { day: ymd(d), since, until };
}

/**
 * Oldest-first, n contiguous local days ending with the day containing nowMs.
 * @param {number} n @param {number} nowMs
 */
function lastNDays(n, nowMs) {
  const d = new Date(nowMs);
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayBounds(new Date(y, m, day - i).getTime()));
  return out;
}

/**
 * The 24h view: 24 consecutive hourly buckets ending with the bucket containing nowMs.
 * Choice: the newest bucket starts at the local hour start of nowMs, then every other
 * bucket is exactly 3600000 ms earlier (real elapsed hours). On a DST change day that
 * means keys may skip or repeat a local hour label, but buckets never overlap or gap.
 * @param {number} nowMs
 * @returns {{ key: string, since: number, until: number }[]}
 */
function hourBuckets(nowMs) {
  const d = new Date(nowMs);
  const last = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
  const H = 3600000;
  const out = [];
  for (let i = 23; i >= 0; i--) {
    const since = last - i * H;
    const k = new Date(since);
    out.push({ key: ymd(k) + 'T' + pad(k.getHours()), since, until: since + H });
  }
  return out;
}

/** @param {number} nowMs local midnight on the 1st of that month */
function monthStart(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

module.exports = { dayStart, dayBounds, lastNDays, hourBuckets, monthStart };
