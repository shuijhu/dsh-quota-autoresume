# Quota Auto-Resume (套餐额度自动续跑)

A DeepSeek Harness plugin that keeps a task alive across a plan-quota reset.

[![dsh-plugin](https://img.shields.io/badge/label-dsh--plugin-0969da)](https://github.com/calesthio/dsh-quota-autoresume/labels/dsh-plugin)

## What it does

1. A model request that exhausts the plan quota ends the turn with an error.
   The plugin recognises that failure (HTTP 429, `rate_limit`, `quota`,
   `insufficient`, `余额不足`, `额度`, …) and **parks** the Session instead of
   losing it.
2. It arms a timer for the next quota reset boundary — by default
   **05:00, 10:00, 15:00, 20:00 and 24:00** local time.
3. At that boundary it admits a short "continue" prompt into every parked
   Session, so the agent picks the work up again from where it stopped.

The parked list is written to `state.json` next to the plugin, so a restart of
the Harness does not lose a stopped task. If the Harness was closed while a
task was parked and it starts again after a reset boundary already passed, the
task is resumed immediately. Every action is appended to `plugin.log`.

## Install

```bash
git clone https://github.com/calesthio/dsh-quota-autoresume.git
```

Then install the cloned directory as a bundle — in the Harness Web UI under
**Settings → Plugins → Install bundle**, or from the Plugin Manager tool with
the clone path as the bundle target. The bundle inserts the plugin row
`quota-autoresume`, which is enabled with the defaults below.

## Configuration

The row config lives in `cordis.patch.yml` of this package. To change it for
your profile, add an override to the profile patch layer
(`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: quota-autoresume
  name: '@local/dsh-quota-autoresume'
  config:
    enabled: true
    resetHours: [5, 10, 15, 20, 24]
    resumeMessage: '套餐额度已重置，请继续之前中断的任务。'
    detectAllErrors: false
    maxAttempts: 0
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `resetHours` | `[5,10,15,20,24]` | Local hours of the quota reset. `24` means midnight. |
| `resumeMessage` | Chinese continue prompt | Message handed to the parked task. |
| `detectAllErrors` | `false` | Park on any turn error, not only quota-shaped ones. |
| `maxAttempts` | `0` | Resume attempts per parked task; `0` means unlimited. |
| `quotaPatterns` | built-in list | Extra regular expressions that mark a failure as a quota failure. |

## Controls

- **Slash command** `/quota-resume` — prints the parked tasks and the next
  reset time; `/quota-resume now` resumes every parked task immediately.
- **Tool** `quota_autoresume` — `action: "status" | "resume_now" | "forget"`.
  The tool is registered globally, so an agent preset that restricts the tool
  set hides it; the slash command always works.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Plugin entry: detection, parking, reset timer, resume. |
| `schedule.js` | Pure reset-boundary arithmetic and quota-failure detection. |
| `test/schedule.test.mjs` | Checks for both — run `node test/schedule.test.mjs`. |
| `state.json` / `plugin.log` | Runtime state and log (git-ignored). |
