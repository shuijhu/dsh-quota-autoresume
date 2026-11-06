/**
 * Quota auto-resume plugin for the DeepSeek Harness.
 *
 * A model request that exhausts the plan quota ends the turn with an error, so
 * the task is left half-done. This plugin parks such a Session, waits for the
 * next quota reset boundary, and then admits a short "continue" prompt into the
 * same Session so the agent picks the work up again.
 *
 * Reset boundaries are local wall-clock hours (default 5, 10, 15, 20, 24).
 *
 * Extension points used:
 *   - `session/event` (durable turn/end) to observe why a turn stopped.
 *   - `agent/error` as a secondary signal for failures raised outside a turn.
 *   - `sessionController.prompt` to wake a stopped Session again.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_RESET_HOURS,
  isQuotaFailure,
  lastResetBefore,
  nextResetAfter,
} from './schedule.js'

/** Default substrings that mark a failure as "the plan ran out". */
const DEFAULT_QUOTA_PATTERNS = Object.freeze([
  'rate[\\s_-]?limit',
  'too many requests',
  'quota',
  'insufficient',
  'balance',
  '余额不足',
  '额度',
  '限额',
  '限流',
  '超出.{0,8}限制',
  '429',
])

/** Default message handed to the parked Session when the quota is back. */
const DEFAULT_RESUME_MESSAGE =
  '套餐额度已重置。请继续之前因额度耗尽而中断的任务，从中断处接着做，不要重复已完成的部分；如果任务其实已经完成，只需说明结论。'

const STATE_FILE = 'state.json'
const LOG_FILE = 'plugin.log'
const STATE_VERSION = 1
const LABEL = '[quota-autoresume]'

/**
 * Read one option from the row config, tolerating a schemastery-backed value.
 * @param {Record<string, unknown> | undefined} config Raw row config.
 * @param {string} key Option name.
 * @param {unknown} fallback Value used when the option is absent.
 * @returns {unknown} The effective option value.
 */
function readOption(config, key, fallback) {
  const raw = config?.[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const value = raw.get()
      return value === undefined || value === null ? fallback : value
    } catch {
      return fallback
    }
  }
  return raw
}

/**
 * Normalize the configured reset hours into sorted, unique, valid hours.
 * @param {unknown} raw Configured value.
 * @returns {number[]} Effective reset hours.
 */
function normalizeHours(raw) {
  const source = Array.isArray(raw) ? raw : DEFAULT_RESET_HOURS
  const hours = []
  for (const entry of source) {
    const hour = Number(entry)
    if (!Number.isInteger(hour) || hour < 0 || hour > 24) continue
    if (!hours.includes(hour)) hours.push(hour)
  }
  if (!hours.length) return [...DEFAULT_RESET_HOURS]
  return hours.sort((left, right) => left - right)
}

/**
 * Compile the configured quota patterns, skipping unusable ones.
 * @param {unknown} raw Configured value.
 * @returns {RegExp[]} Effective patterns.
 */
function normalizePatterns(raw) {
  const source = Array.isArray(raw) ? raw : DEFAULT_QUOTA_PATTERNS
  const patterns = []
  for (const entry of source) {
    if (entry instanceof RegExp) {
      patterns.push(entry)
      continue
    }
    if (typeof entry !== 'string' || !entry.trim()) continue
    try {
      patterns.push(new RegExp(entry, 'i'))
    } catch {
      // An unusable pattern must never stop the plugin from loading.
    }
  }
  return patterns.length ? patterns : DEFAULT_QUOTA_PATTERNS.map(entry => new RegExp(entry, 'i'))
}

/**
 * Read and validate the effective plugin configuration.
 * @param {Record<string, unknown> | undefined} raw Raw row config.
 * @returns {{enabled: boolean, hours: number[], patterns: RegExp[], message: string, detectAllErrors: boolean, maxAttempts: number}} Effective configuration.
 */
function normalizeConfig(raw) {
  const message = String(readOption(raw, 'resumeMessage', DEFAULT_RESUME_MESSAGE) || DEFAULT_RESUME_MESSAGE)
  const maxAttempts = Number(readOption(raw, 'maxAttempts', 0))
  return {
    enabled: readOption(raw, 'enabled', true) !== false,
    hours: normalizeHours(readOption(raw, 'resetHours', DEFAULT_RESET_HOURS)),
    patterns: normalizePatterns(readOption(raw, 'quotaPatterns', DEFAULT_QUOTA_PATTERNS)),
    message,
    detectAllErrors: readOption(raw, 'detectAllErrors', false) === true,
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 0,
  }
}

/**
 * Summarize a failure for the log and for the status report.
 * @param {unknown} failure Failure value.
 * @returns {string} Short human-readable description.
 */
function describeFailure(failure) {
  if (!failure) return 'unknown failure'
  if (typeof failure === 'string') return failure.slice(0, 400)
  if (typeof failure !== 'object') return String(failure)
  const parts = []
  for (const key of ['code', 'status', 'message']) {
    const value = (failure)[key]
    if (value !== undefined && value !== null) parts.push(`${key}=${String(value).slice(0, 300)}`)
  }
  return parts.join(' ') || 'unknown failure'
}

/**
 * Schedule one callback with the platform timer.
 *
 * The plugin owns its timer outright instead of borrowing a context-scoped
 * helper: a long pending timer would keep the plugin fiber from settling, and
 * a profile recomposition waits for that fiber before it can apply anything.
 *
 * @param {() => void} callback Callback to run.
 * @param {number} delay Delay in milliseconds.
 * @returns {() => void} Disposer that cancels the timer.
 */
function scheduleTimeout(callback, delay) {
  const handle = setTimeout(callback, delay)
  return () => clearTimeout(handle)
}

/**
 * Resolve the callable that admits a prompt into a Session.
 *
 * Cordis only exposes an injected service on its context, so the controller is
 * read from the property first and the raw accessor is only a fallback.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @returns {((request: unknown, signal: AbortSignal) => Promise<unknown>) | null} Prompt callable.
 */
function resolvePrompt(ctx) {
  try {
    const controller = ctx.sessionController
    if (controller && typeof controller.prompt === 'function') {
      return (request, signal) => controller.prompt(request, signal)
    }
  } catch {
    // Fall through to the generated remote namespace.
  }
  try {
    const remote = ctx.remote
    if (remote?.session && typeof remote.session.prompt === 'function') {
      return (request, signal) => remote.session.prompt(request, signal)
    }
  } catch {
    // Fall through to the raw accessor.
  }
  try {
    const controller = ctx.get?.('sessionController')
    if (controller && typeof controller.prompt === 'function') {
      return (request, signal) => controller.prompt(request, signal)
    }
  } catch {
    // No prompt path is available.
  }
  return null
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {Record<string, unknown>} config Row config.
 * @returns {() => void} Cleanup disposer.
 */export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const parked = new Map()
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const statePath = join(pluginDir, STATE_FILE)
  const logPath = join(pluginDir, LOG_FILE)

  let timerDisposer = null
  let disposed = false
  let requestSeq = 0
  let persistChain = Promise.resolve()

  /**
   * Write one log line through the Host logger and to the plugin log file.
   * @param {'info' | 'warn' | 'error'} level Log level.
   * @param {string} message Message text.
   * @returns {void}
   */
  const log = (level, message) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](`${LABEL} ${message}`)
    } catch {
      // Logging must never break the plugin.
    }
    try {
      void appendFile(logPath, `${line}\n`, 'utf8').catch(() => {})
    } catch {
      // Logging must never break the plugin.
    }
  }

  /**
   * Persist the parked list so a restart does not lose a stopped task.
   * @returns {Promise<void>} Resolves once the write settled.
   */
  const persist = () => {
    persistChain = persistChain
      .then(async () => {
        const payload = {
          version: STATE_VERSION,
          updatedAt: Date.now(),
          parked: [...parked.values()],
        }
        await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      })
      .catch(error => log('warn', `failed to persist parked sessions: ${String(error)}`))
    return persistChain
  }

  /**
   * Restore the parked list written by an earlier run.
   * @returns {Promise<void>} Resolves once the restore settled.
   */
  const restore = async () => {
    try {
      const raw = await readFile(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      const entries = Array.isArray(parsed?.parked) ? parsed.parked : []
      for (const entry of entries) {
        if (!entry || typeof entry.sessionId !== 'string') continue
        parked.set(entry.sessionId, {
          sessionId: entry.sessionId,
          parkedAt: Number(entry.parkedAt) || Date.now(),
          updatedAt: Date.now(),
          attempts: Number(entry.attempts) || 1,
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        })
      }
      if (parked.size) log('info', `restored ${parked.size} parked session(s) from ${STATE_FILE}`)
    } catch {
      // No state file yet — nothing to restore.
    }
  }

  /**
   * Park one Session until the next quota reset.
   * @param {string} sessionId Session identity.
   * @param {unknown} failure Failure that stopped the task.
   * @returns {void}
   */
  const park = (sessionId, failure) => {
    const existing = parked.get(sessionId)
    const record = {
      sessionId,
      parkedAt: existing?.parkedAt ?? Date.now(),
      updatedAt: Date.now(),
      attempts: (existing?.attempts ?? 0) + 1,
      reason: describeFailure(failure),
    }
    if (options.maxAttempts > 0 && record.attempts > options.maxAttempts) {
      parked.delete(sessionId)
      log('warn', `giving up on ${sessionId} after ${record.attempts} resume attempts`)
      void persist()
      return
    }
    parked.set(sessionId, record)
    log('warn', `parked ${sessionId}: ${record.reason}`)
    void persist()
  }

  /**
   * Admit one continue prompt into a stopped Session.
   * @param {string} sessionId Session identity.
   * @returns {Promise<boolean>} Whether the prompt was accepted.
   */
  const resumeSession = async sessionId => {
    const prompt = injectedPrompt ?? resolvePrompt(ctx)
    if (!prompt) {
      log('error', 'no session prompt service is available; cannot resume')
      return false
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      await prompt(
        {
          requestId: `quota-autoresume-${Date.now()}-${requestSeq++}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: options.message }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        controller.signal,
      )
      log('info', `resumed ${sessionId}`)
      return true
    } catch (error) {
      log('error', `failed to resume ${sessionId}: ${String(error)}`)
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Resume every parked Session.
   * @returns {Promise<{resumed: string[], failed: string[]}>} Resume outcome.
   */
  const resumeAll = async () => {
    const resumed = []
    const failed = []
    for (const record of [...parked.values()]) {
      const ok = await resumeSession(record.sessionId)
      if (ok) {
        resumed.push(record.sessionId)
        parked.delete(record.sessionId)
      } else {
        failed.push(record.sessionId)
      }
    }
    if (resumed.length || failed.length) await persist()
    return { resumed, failed }
  }

  /**
   * Arm the timer for the next reset boundary.
   * @returns {void}
   */
  const scheduleTimer = () => {
    if (timerDisposer) {
      try {
        timerDisposer()
      } catch {
        // A stale disposer must not stop the new timer.
      }
      timerDisposer = null
    }
    if (disposed || !options.enabled) return
    const target = nextResetAfter(new Date(), options.hours)
    const delay = Math.max(1_000, target.getTime() - Date.now())
    const fire = () => {
      timerDisposer = null
      void handleReset()
    }
    timerDisposer = scheduleTimeout(fire, delay)
    log('info', `next quota reset at ${target.toLocaleString()}`)
  }

  /**
   * Handle one quota reset boundary.
   * @returns {Promise<void>} Resolves once the boundary was handled.
   */
  const handleReset = async () => {
    scheduleTimer()
    if (!options.enabled) return
    if (!parked.size) return
    log('info', `quota reset reached; resuming ${parked.size} parked session(s)`)
    await resumeAll()
  }

  /**
   * Read the plugin state for the status report.
   * @returns {Record<string, unknown>} Status payload.
   */
  const status = () => {
    const now = new Date()
    return {
      enabled: options.enabled,
      resetHours: options.hours,
      nextResetAt: nextResetAfter(now, options.hours).toISOString(),
      lastResetAt: (lastResetBefore(now, options.hours)?.toISOString() ?? ''),
      resumeMessage: options.message,
      parked: [...parked.values()].map(record => ({
        sessionId: record.sessionId,
        parkedAt: new Date(record.parkedAt).toISOString(),
        attempts: record.attempts,
        reason: record.reason,
      })),
    }
  }

  /**
   * Render the status payload as readable text.
   * @param {unknown} _args Tool arguments.
   * @param {unknown} value Tool value.
   * @returns {{type: 'text', text: string}[]} Content blocks.
   */
  const renderStatus = (_args, value) => {
    const data = value && typeof value === 'object' ? value : {}
    const lines = []
    lines.push(`套餐自动续跑：${data.enabled ? '已启用' : '已停用'}`)
    lines.push(`重置时间：${(Array.isArray(data.resetHours) ? data.resetHours : []).join('、')} 点`)
    lines.push(`下次重置：${data.nextResetAt ?? '未知'}`)
    const parkedList = Array.isArray(data.parked) ? data.parked : []
    lines.push(`待续跑任务：${parkedList.length} 个`)
    for (const record of parkedList) {
      lines.push(`- ${record.sessionId}（${record.reason || 'unknown'}）`)
    }
    if (Array.isArray(data.resumed) && data.resumed.length) {
      lines.push(`已立即续跑：${data.resumed.join('、')}`)
    }
    if (Array.isArray(data.failed) && data.failed.length) {
      lines.push(`续跑失败：${data.failed.join('、')}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  const toolDefinition = {
    name: 'quota_autoresume',
    description:
      '查看套餐额度重置后的自动续跑状态，或立即续跑被额度耗尽中断的任务。'
      + 'action=status 查看待续跑任务与下次重置时间；action=resume_now 立即续跑（可指定 sessionId，缺省则续跑全部）；action=forget 放弃某个待续跑任务。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'resume_now', 'forget'],
          description: '要执行的动作。',
        },
        sessionId: {
          type: 'string',
          description: '目标会话标识；resume_now 缺省时续跑全部待续跑任务。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          resetHours: { type: 'array', items: { type: 'number' } },
          nextResetAt: { type: 'string' },
          lastResetAt: { type: 'string' },
          resumeMessage: { type: 'string' },
          parked: { type: 'array', items: { type: 'object' } },
          resumed: { type: 'array', items: { type: 'string' } },
          failed: { type: 'array', items: { type: 'string' } },
          forgotten: { type: 'array', items: { type: 'string' } },
        },
        required: ['enabled', 'resetHours', 'nextResetAt', 'parked'],
        additionalProperties: false,
      },
      render: renderStatus,
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const action = typeof input.action === 'string' ? input.action : 'status'
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined

      if (action === 'resume_now') {
        if (sessionId) {
          const ok = await resumeSession(sessionId)
          if (ok) {
            parked.delete(sessionId)
            await persist()
          }
          return { ...status(), resumed: ok ? [sessionId] : [], failed: ok ? [] : [sessionId] }
        }
        const outcome = await resumeAll()
        return { ...status(), ...outcome }
      }

      if (action === 'forget') {
        const forgotten = []
        for (const record of [...parked.values()]) {
          if (sessionId && record.sessionId !== sessionId) continue
          parked.delete(record.sessionId)
          forgotten.push(record.sessionId)
        }
        if (forgotten.length) await persist()
        return { ...status(), forgotten }
      }

      return status()
    },
  }

  // --- registration -------------------------------------------------------

  log(
    'info',
    `loaded; enabled=${options.enabled} resetHours=${options.hours.join(',')}`
    + ` detectAllErrors=${options.detectAllErrors} maxAttempts=${options.maxAttempts}`
    + ` message=${JSON.stringify(options.message)}`,
  )

  let disposeTool = null
  let disposeCommand = null
  let injectedPrompt = null

  // Cordis only exposes a service on a context that injected it, so the tool,
  // the command, and the session controller are taken from one injection.
  ctx.inject(['tools', 'commands', 'sessionController'], child => {
    try {
      injectedPrompt = resolvePrompt(child)
    } catch {
      injectedPrompt = null
    }
    try {
      const tools = child.tools
      if (tools && typeof tools.register === 'function') {
        disposeTool = tools.register(toolDefinition)
        log('info', 'registered the quota_autoresume tool')
      } else {
        log('warn', 'tool service is unavailable; the quota_autoresume tool was not registered')
      }
    } catch (error) {
      log('error', `failed to register the quota_autoresume tool: ${String(error)}`)
    }
    try {
      const commands = child.commands
      if (commands && typeof commands.register === 'function') {
        disposeCommand = commands.register({
          name: 'quota-resume',
          description: '套餐额度自动续跑：查看待续跑任务与下次重置时间；加 now 立即续跑全部待续跑任务。',
          handler: async invocation => {
            const raw = (invocation?.rawInput ?? '').trim()
            const text = value => renderStatus(null, value).map(block => block.text).join('\n')
            if (!raw) {
              return { kind: 'success', text: text(status()) }
            }
            if (raw === 'now' || raw === '立即' || raw === 'all') {
              const outcome = await resumeAll()
              return { kind: 'success', text: text({ ...status(), ...outcome }) }
            }
            const ok = await resumeSession(raw)
            if (ok) {
              parked.delete(raw)
              await persist()
            }
            const summary = text({
              ...status(),
              resumed: ok ? [raw] : [],
              failed: ok ? [] : [raw],
            })
            return ok ? { kind: 'success', text: summary } : { kind: 'error', text: summary }
          },
        })
        log('info', 'registered the /quota-resume command')
      } else {
        log('warn', 'command service is unavailable; the /quota-resume command was not registered')
      }
    } catch (error) {
      log('error', `failed to register the /quota-resume command: ${String(error)}`)
    }
    return () => {
      try {
        disposeTool?.()
      } catch {
        // Nothing else to do while unloading.
      }
      try {
        disposeCommand?.()
      } catch {
        // Nothing else to do while unloading.
      }
    }
  })

  const disposeAgentError = ctx.on('agent/error', (...args) => {
    const payload = args.find(arg => arg && typeof arg === 'object' && 'agent' in arg && 'error' in arg)
    if (!payload) return
    const agent = payload.agent
    const sessionId = agent?.id
    if (!sessionId) return
    if (!isQuotaFailure(payload.error, options.patterns) && !options.detectAllErrors) return
    park(sessionId, payload.error)
  })

  const disposeSessionEvent = ctx.on('session/event', (...args) => {
    const session = args.find(arg => arg && typeof arg === 'object' && 'id' in arg && 'header' in arg)
    const event = args.find(arg => arg && typeof arg === 'object' && typeof arg.type === 'string' && 'data' in arg)
    if (!session || !event || event.type !== 'turn/end') return
    const reason = event.data?.reason
    if (!reason) return
    if (reason.kind === 'completed') {
      if (parked.delete(session.id)) void persist()
      return
    }
    if (reason.kind === 'error') {
      if (!isQuotaFailure(reason.error, options.patterns) && !options.detectAllErrors) return
      if (session.header?.origin === 'subagent') return
      park(session.id, reason.error)
    }
  })

  // Startup work runs detached from the effect chain: the plugin fiber must
  // stay settleable, because a profile recomposition waits for it.
  const startup = new AbortController()
  ctx.effect(() => () => startup.abort())
  void (async () => {
    try {
      await restore()
      if (startup.signal.aborted) return
      if (!options.enabled) {
        log('info', 'plugin is disabled by configuration')
        return
      }
      scheduleTimer()
      const now = Date.now()
      const boundary = lastResetBefore(new Date(now), options.hours)
      const overdue = [...parked.values()].filter(record => boundary && record.parkedAt < boundary.getTime())
      if (overdue.length) {
        log('info', `quota reset already passed for ${overdue.length} parked session(s); resuming now`)
        await resumeAll()
      }
    } catch (error) {
      log('error', `startup failed: ${String(error)}`)
    }
  })()

  return () => {
    disposed = true
    startup.abort()
    if (timerDisposer) {
      try {
        timerDisposer()
      } catch {
        // Nothing else to do while unloading.
      }
      timerDisposer = null
    }
    try {
      disposeAgentError?.()
    } catch {
      // Nothing else to do while unloading.
    }
    try {
      disposeSessionEvent?.()
    } catch {
      // Nothing else to do while unloading.
    }
    try {
      disposeTool?.()
    } catch {
      // Nothing else to do while unloading.
    }
    try {
      disposeCommand?.()
    } catch {
      // Nothing else to do while unloading.
    }
  }
}
