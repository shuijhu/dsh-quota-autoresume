/**
 * Checks for the quota auto-resume plugin: reset-boundary arithmetic and
 * quota-failure detection.
 *
 * Run: node test/schedule.test.mjs
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_RESET_HOURS,
  isQuotaFailure,
  lastResetBefore,
  nextResetAfter,
} from '../schedule.js'

const HOURS = DEFAULT_RESET_HOURS
const patterns = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /quota/i,
  /insufficient/i,
  /balance/i,
  /余额不足/,
  /额度/,
  /限额/,
  /限流/,
  /超出.{0,8}限制/,
  /429/,
]

/**
 * Format a moment as a local wall-clock stamp.
 * @param {Date} moment Moment to format.
 * @returns {string} `YYYY-MM-DD HH:mm:ss`.
 */
function stamp(moment) {
  const pad = value => String(value).padStart(2, '0')
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`
    + ` ${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`
}

// --- reset boundaries ------------------------------------------------------

const cases = [
  ['2026-11-06T00:05:00', '2026-11-06 05:00:00'],
  ['2026-11-06T04:59:59', '2026-11-06 05:00:00'],
  ['2026-11-06T05:00:00', '2026-11-06 10:00:00'],
  ['2026-11-06T09:59:59', '2026-11-06 10:00:00'],
  ['2026-11-06T14:00:00', '2026-11-06 15:00:00'],
  ['2026-11-06T19:59:59', '2026-11-06 20:00:00'],
  ['2026-11-06T23:30:00', '2026-11-07 00:00:00'],
  ['2026-11-06T23:59:59', '2026-11-07 00:00:00'],
  ['2026-11-06T00:00:00', '2026-11-06 05:00:00'],
]

for (const [from, expected] of cases) {
  const next = nextResetAfter(new Date(from), HOURS)
  assert.equal(stamp(next), expected, `next reset after ${from}`)
}

// The previous boundary must always sit strictly before the moment and the
// next boundary strictly after it.
for (const [from] of cases) {
  const moment = new Date(from)
  const previous = lastResetBefore(moment, HOURS)
  const next = nextResetAfter(moment, HOURS)
  assert.ok(previous, `a previous boundary exists for ${from}`)
  assert.ok(previous.getTime() <= moment.getTime(), `previous boundary precedes ${from}`)
  assert.ok(next.getTime() > moment.getTime(), `next boundary follows ${from}`)
  assert.ok(next.getTime() - previous.getTime() <= 5 * 60 * 60 * 1000, `gap stays within five hours for ${from}`)
}

// The boundary sequence must repeat every day.
const midnight = new Date('2026-11-06T00:00:00')
assert.equal(stamp(nextResetAfter(midnight, HOURS)), '2026-11-06 05:00:00')
assert.equal(stamp(nextResetAfter(new Date('2026-11-06T05:00:00'), HOURS)), '2026-11-06 10:00:00')

// --- quota-failure detection ----------------------------------------------

// The real failure shape observed from the MiniMax Token Plan.
const minimax = {
  message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","request_id":"073bc511f4af697159913aad61ab7e93"}}',
  code: 'RATE_LIMIT',
}
assert.equal(isQuotaFailure(minimax, patterns), true, 'MiniMax Token Plan limit is detected')

assert.equal(isQuotaFailure({ code: 'rate_limit_error', status: 429 }, patterns), true, 'HTTP 429 is detected')
assert.equal(isQuotaFailure({ message: 'insufficient balance' }, patterns), true, 'balance errors are detected')
assert.equal(isQuotaFailure('额度不足', patterns), true, 'Chinese quota errors are detected')

// Ordinary failures must not park a task.
assert.equal(isQuotaFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:11434' }, patterns), false, 'connection errors are ignored')
assert.equal(isQuotaFailure({ message: 'file not found' }, patterns), false, 'missing files are ignored')
assert.equal(isQuotaFailure({ message: 'invalid request: missing field "model"' }, patterns), false, 'bad requests are ignored')
assert.equal(isQuotaFailure(undefined, patterns), false, 'no failure is not a quota failure')

console.log('schedule.test.mjs: all checks passed')
