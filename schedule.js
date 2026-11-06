/**
 * Pure helpers of the quota auto-resume plugin: reset-boundary arithmetic and
 * quota-failure detection. Kept in its own module so the behaviour can be
 * tested without loading the plugin into a Cordis context.
 */

/** Default quota reset boundaries, in local hours. 24 means midnight. */
export const DEFAULT_RESET_HOURS = Object.freeze([5, 10, 15, 20, 24])

/**
 * Every reset boundary near the given moment, in local time.
 * @param {Date} when Reference moment.
 * @param {readonly number[]} hours Configured reset hours.
 * @returns {Date[]} Candidate boundaries.
 */
export function boundariesAround(when, hours) {
  const candidates = []
  for (const hour of hours) {
    for (const dayOffset of [0, 1]) {
      const candidate = new Date(when)
      candidate.setDate(candidate.getDate() + dayOffset)
      if (hour === 24) candidate.setHours(0, 0, 0, 0)
      else candidate.setHours(hour, 0, 0, 0)
      candidates.push(candidate)
    }
  }
  return candidates
}

/**
 * The most recent reset boundary at or before the given moment.
 * @param {Date} when Reference moment.
 * @param {readonly number[]} hours Configured reset hours.
 * @returns {Date | undefined} The latest boundary that already happened.
 */
export function lastResetBefore(when, hours) {
  let latest
  for (const candidate of boundariesAround(when, hours)) {
    if (candidate.getTime() > when.getTime()) continue
    if (!latest || candidate.getTime() > latest.getTime()) latest = candidate
  }
  return latest
}

/**
 * The next reset boundary strictly after the given moment.
 * @param {Date} when Reference moment.
 * @param {readonly number[]} hours Configured reset hours.
 * @returns {Date} The next boundary.
 */
export function nextResetAfter(when, hours) {
  let earliest
  for (const candidate of boundariesAround(when, hours)) {
    if (candidate.getTime() <= when.getTime()) continue
    if (!earliest || candidate.getTime() < earliest.getTime()) earliest = candidate
  }
  return earliest ?? new Date(when.getTime() + 60 * 60 * 1000)
}

/**
 * Whether a failure looks like an exhausted plan quota rather than a real bug.
 * @param {unknown} failure Failure value from the turn or the agent.
 * @param {readonly RegExp[]} patterns Configured quota patterns.
 * @returns {boolean} Whether the failure is a quota failure.
 */
export function isQuotaFailure(failure, patterns) {
  if (!failure) return false
  if (typeof failure === 'string') return patterns.some(pattern => pattern.test(failure))
  if (typeof failure !== 'object') return false
  const status = (failure).status
  if (status === 429 || status === 402 || status === '429') return true
  const parts = []
  for (const key of ['code', 'message', 'name', 'type', 'reason', 'statusText']) {
    const value = (failure)[key]
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value))
  }
  const cause = (failure).cause
  if (cause && typeof cause === 'object') {
    for (const key of ['code', 'message', 'name']) {
      const value = (cause)[key]
      if (typeof value === 'string') parts.push(value)
    }
  }
  const text = parts.join(' | ')
  return text.length > 0 && patterns.some(pattern => pattern.test(text))
}
