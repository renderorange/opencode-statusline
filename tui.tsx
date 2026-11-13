/**
 * opencode-statusline
 *
 * Draws a shell-prompt-style statusline in the OpenCode TUI:
 *
 *   ~/git/project (main) 12% - 4m 32s
 *
 * The formatting is not reimplemented here.  This plugin gathers the session's details,
 * hands them to bin/opencode-statusline as JSON on STDIN, and renders the colored line it
 * prints back.  Sections, separators, labels and the context-color thresholds therefore
 * live in the formatter's config: $XDG_CONFIG_HOME/opencode-statusline/config.jsonc by
 * default, or the file named by OPENCODE_STATUSLINE_CONFIG.  statusline.example.jsonc is a
 * documented starting point to copy there.
 *
 * bin/opencode-statusline lives beside this file, so the plugin has no dependency
 * outside this directory.
 *
 * The output is ANSI, not markup, so it is split back into spans before rendering.
 *
 * This checkout is also checked for upstream commits, on a timer rather than per redraw:
 * a statusline must never wait on a network call.  The answer is cached in plugin storage,
 * so a restart doesn't re-fetch, and it only ever appends a marker; nothing is pulled.
 *
 * Where it draws: in the prompt footer, so it sits flush under the input with no offset
 * arithmetic. A session panel (the Subagents view) replaces the composer, footer included,
 * so the bar is absent while one is open. A menu that overlays the composer instead — the
 * slash-command menu — leaves the bar in place. The built-in `opencode.prompt.footer`
 * plugin is disabled in cli.json: its row is what used to sit above this one, and removing
 * it is what leaves the blank row under the input.
 */
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Where this file is: the formatter lives beside it, and so does the repo we check. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The formatter, which lives beside this file.  OPENCODE_STATUSLINE_SCRIPT overrides it. */
const SCRIPT = process.env.OPENCODE_STATUSLINE_SCRIPT ?? join(HERE, "bin", "opencode-statusline")

/** How often the line is redrawn.  The script runs git, so this stays cheap. */
const REFRESH_MS = 1000

/** Seconds to wait for the script before leaving the previous line in place. */
const TIMEOUT_MS = 3000

/** How often to ask the remote for new commits.  A day, like npm's update-notifier. */
const UPDATE_MS = 24 * 60 * 60 * 1000

/** Spread the first check out, so restarts don't all fetch at once or stall the first draw. */
const JITTER_MS = 2 * 60 * 1000

/** Seconds to wait for the remote before giving up on it for now. */
const FETCH_MS = 20000

type Span = { text: string; color?: string; muted?: boolean }

type Result = { stdout: string; code: number | null; error?: string }

/** Splits a line of 24-bit ANSI-colored text into spans. */
function toSpans(line: string): Span[] {
  const spans: Span[] = []
  const pattern = /\u001b\[([0-9;]*)m/g
  let color: string | undefined
  let muted = false
  let index = 0

  for (const match of line.matchAll(pattern)) {
    const text = line.slice(index, match.index)
    if (text) spans.push({ text, color, muted })

    const parts = match[1].split(";").map((part) => Number(part || "0"))

    if (parts[0] === 38 && parts[1] === 2) {
      const hex = parts
        .slice(2, 5)
        .map((part) => part.toString(16).padStart(2, "0"))
        .join("")
      color = `#${hex}`
      muted = false
    } else if (parts[0] === 90) {
      // Bright black: the formatter's "muted" sections, mapped to the theme's own
      // muted text color rather than a fixed grey
      color = undefined
      muted = true
    } else if (parts[0] === 0 || parts[0] === 39 || match[1] === "") {
      // 0 is a full reset, which command output uses far more often than 39
      color = undefined
      muted = false
    }

    index = match.index + match[0].length
  }

  const rest = line.slice(index)
  if (rest) spans.push({ text: rest, color, muted })

  return spans
}

/** Sums the tokens an assistant message accounted for, which is what fills the window. */
function contextOf(message: any): { used: number; read: number; write: number; input: number } | undefined {
  const tokens = message?.tokens
  if (!tokens) return undefined

  const read = tokens.cache?.read ?? 0
  const write = tokens.cache?.write ?? 0
  const input = tokens.input ?? 0
  const used = input + read + write + (tokens.output ?? 0)

  return used > 0 ? { used, read, write, input } : undefined
}

export default Plugin.define({
  id: "renderorange.statusline",

  async setup(context) {
    // Imported lazily: if the runtime can't spawn processes, we surface it as a toast
    // instead of failing the whole module load with no explanation.
    let spawn: typeof import("node:child_process").spawn
    try {
      spawn = (await import("node:child_process")).spawn
    } catch (error) {
      context.ui.toast.show({ variant: "error", message: `statusline: no child_process: ${error}` })
      return
    }

    const location = context.location ?? context.data.location.default()

    /** Runs a program, optionally feeding it input, and keeps the start of what it prints. */
    const capture = (command: string, args: string[], options: { cwd?: string; input?: string; timeoutMs: number; env?: Record<string, string> }): Promise<Result> =>
      new Promise((resolve) => {
        let stdout = ""
        let settled = false

        const child = spawn(command, args, {
          cwd: options.cwd ?? location.directory,
          env: { ...process.env, ...options.env },
          stdio: ["pipe", "pipe", "ignore"],
        })

        const finish = (result: Result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }

        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          finish({ stdout, code: null, error: "timeout" })
        }, options.timeoutMs)

        child.stdout?.setEncoding("utf8")
        child.stdout?.on("data", (chunk: string) => {
          // The script caps its own output; this cap is for a misbehaving replacement
          if (stdout.length < 8192) stdout += chunk
        })
        child.on("error", (error) => finish({ stdout, code: null, error: String(error) }))
        child.on("close", (code) => finish({ stdout, code }))
        child.stdin?.on("error", () => {})
        child.stdin?.end(options.input ?? "")
      })

    const [line, setLine] = createSignal<Span[]>([])
    const [behind, setBehind] = createSignal(0)

    /** Survives restarts, so launching the TUI repeatedly doesn't hit the network. */
    const [updates, setUpdates] = context.storage.store("updates", {
      initial: { checked: 0, behind: 0 },
    })

    let busy = false

    /** The count we've already told the user about, so the toast fires once per finding. */
    let announced = updates?.behind ?? 0

    /**
     * The session being shown.  `context.ui.router.current` is documented as a function
     * but is a plain property in some builds, so both are accepted; a wrong assumption
     * here used to fail silently and take context, time and variant with it.
     */
    const routeCurrent = (): any => {
      const router: any = (context.ui as any)?.router
      const value = router?.current
      return typeof value === "function" ? value() : value
    }

    const activeSessionID = (): string | undefined => {
      try {
        const current = routeCurrent()
        if (!current || typeof current !== "object") return undefined

        const id = current.params?.sessionID ?? current.sessionID ?? current.params?.id
        return typeof id === "string" && id.length > 0 ? id : undefined
      } catch {
        return undefined
      }
    }

    /** The selected model's record, for its display name and its context limit. */
    const modelRecord = (): any => {
      let selected: any
      try {
        selected = context.ui.model.current()
      } catch {
        return undefined
      }

      const wanted = selected?.modelID ?? selected?.id
      const models = context.data.location.model.list(location) ?? []
      return (
        models.find((model: any) => model.id === wanted && model.providerID === selected?.providerID) ??
        models.find((model: any) => model.id === wanted)
      )
    }

    /**
     * A provider's display name, e.g. "Alibaba Token Plan".  Falls back to the id with
     * its separators turned into spaces, so the line still reads well before provider
     * data has synced.
     */
    const providerLabel = (providerID?: string): string | undefined => {
      if (!providerID) return undefined

      try {
        const providers = context.data.location.provider.list(location) ?? []
        const found = providers.find((provider: any) => provider.id === providerID)
        if (found?.name) return found.name
      } catch {
        /* fall through to the prettified id */
      }

      return providerID
        .split(/[-_.]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
    }

    /** The remote branch to compare against, or nothing when there isn't one. */
    const upstream = async (): Promise<string | undefined> => {
      const head = await capture("git", ["-C", HERE, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        timeoutMs: 5000,
      })
      if (head.code === 0 && head.stdout.trim()) return head.stdout.trim()

      for (const name of ["origin/main", "origin/master"]) {
        const found = await capture("git", ["-C", HERE, "rev-parse", "--verify", "--quiet", name], { timeoutMs: 5000 })
        if (found.code === 0) return name
      }

      return undefined
    }

    /** Cached between restarts; a failure of any kind means "no marker", never an error. */
    const checkForUpdates = async () => {
      const cached = updates
      const due = Date.now() - (cached?.checked ?? 0) >= UPDATE_MS

      if (!due) {
        setBehind(cached?.behind ?? 0)
        return
      }

      // Record the attempt whether or not it works, so an offline machine retries
      // tomorrow instead of on every launch
      const attempted = async (count?: number) => {
        if (count !== undefined) {
          setBehind(count)
          if (count > 0 && count !== announced) {
            announced = count
            context.ui.toast.show({
              variant: "info",
              message: `opencode-statusline: ${count} upstream commit${count === 1 ? "" : "s"} available`,
            })
          }
        }

        await setUpdates((draft) => {
          draft.checked = Date.now()
          if (count !== undefined) draft.behind = count
        })
      }

      const repo = await capture("git", ["-C", HERE, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 5000 })
      if (repo.code !== 0) return

      // No remote yet: leave the timestamp alone, so adding one takes effect on the next
      // launch instead of waiting out the interval
      const url = await capture("git", ["-C", HERE, "remote", "get-url", "origin"], { timeoutMs: 5000 })
      if (url.error || url.code !== 0 || !url.stdout.trim()) return

      const fresh = await capture("git", ["-C", HERE, "fetch", "--quiet", "--prune", "origin"], { timeoutMs: FETCH_MS })
      // Offline, no remote, or no credentials: leave the cached answer alone
      if (fresh.error || fresh.code !== 0) return attempted()

      const remote = await upstream()
      if (!remote) return attempted()

      const counted = await capture("git", ["-C", HERE, "rev-list", "--count", `HEAD..${remote}`], { timeoutMs: 10000 })
      if (counted.code !== 0) return attempted()

      const count = Number(counted.stdout.trim())
      if (!Number.isFinite(count)) return attempted()

      await attempted(count)
    }

    const refresh = async () => {
      if (busy) return
      busy = true

      try {
        const sessionID = activeSessionID()
        const session: any = sessionID ? context.data.session.get(sessionID) : undefined
        const model = modelRecord()

        let usage: ReturnType<typeof contextOf>

        if (sessionID) {
          try {
            await context.data.session.message.sync(sessionID)
            const messages = context.data.session.message.list(sessionID) ?? []

            // The list is the projected SessionMessage union: assistant entries carry
            // `type: "assistant"` and `tokens`; there is no `role` field.
            for (let index = messages.length - 1; index >= 0; index--) {
              const message = messages[index]
              if (message?.type !== "assistant") continue

              const found = contextOf(message)
              if (!found) continue

              usage = found
              break
            }
          } catch {
            /* keep whatever the last redraw settled on */
          }
        }

        const limit = model?.limit?.context
        const percent = usage && limit ? Math.min(100, (usage.used / limit) * 100) : undefined
        const total = usage ? usage.read + usage.write + usage.input : 0
        const hitRatio = usage && total > 0 ? usage.read / total : undefined

        // "DeepSeek V4.1 Flash (Alibaba Token Plan)": the provider rides along in the
        // model section, so the layout needs no extra field for it
        const name = model?.name ?? session?.model?.id
        const provider = providerLabel(model?.providerID ?? session?.model?.providerID)
        const displayName = name && provider ? `${name} (${provider})` : name

        const input = JSON.stringify({
          workspace: { current_dir: location.directory },
          model: { display_name: displayName },
          thinking: session?.model?.variant,
          context_window: {
            used_percentage: percent,
            used_tokens: usage?.used,
            limit_tokens: limit,
            current_usage: usage
              ? {
                  input_tokens: usage.input,
                  cache_read_input_tokens: usage.read,
                  cache_creation_input_tokens: usage.write,
                }
              : undefined,
          },
          prompt_cache: { hit_ratio: hitRatio },
          cost: {
            total_cost_usd: session?.cost,
            total_duration_ms: session?.time?.created ? Date.now() - session.time.created : undefined,
          },
        })

        const result = await capture(SCRIPT, [], {
          cwd: location.directory,
          input,
          timeoutMs: TIMEOUT_MS,
        })

        const first = result.stdout.split("\n")[0]

        if (!first) {
          if (result.error) setLine([{ text: `statusline: ${result.error}` }])
          return
        }

        const spans = toSpans(first)
        setLine(spans)
      } finally {
        busy = false
      }
    }

    void refresh()

    const jitter = setTimeout(() => void checkForUpdates(), Math.random() * JITTER_MS)

    const redraw = setInterval(refresh, REFRESH_MS)
    const poll = setInterval(checkForUpdates, UPDATE_MS)

    /**
     * The theme's base text colour, or undefined (the terminal's own) when the theme has
     * no such token. Reading an unknown token throws, so this is guarded like every other.
     */
    const baseFg = (): any => {
      try {
        return context.theme.text.base
      } catch {
        return undefined
      }
    }

    /**
     * A theme token, or the fallback when the theme has no such name.
     *
     * Reading a token the theme doesn't define raises a ReferenceError rather than
     * returning undefined, and an exception here takes the whole bar down with it.
     */
    const themeColor = (pick: () => any, fallback?: any): any => {
      const instead = fallback ?? baseFg()

      try {
        return pick() ?? instead
      } catch {
        return instead
      }
    }

    // The muted text colour, whichever name this theme gives it. Each candidate is
    // guarded on its own, since an unknown token throws and would otherwise stop the
    // search at the first miss. Read per draw, so a theme switch takes effect without a
    // reload.
    const mutedFg = (): any => {
      let text: any

      try {
        text = context.theme.text
      } catch {
        return baseFg()
      }

      for (const name of ["muted", "subtle", "dim", "weak"]) {
        try {
          const token = text[name]

          if (token) {
            return token
          }
        } catch {
          /* this theme has no such token */
        }
      }

      return baseFg()
    }

    const warningFg = () => themeColor(() => (context.theme as any).warning)

    /** The bar itself: a row of coloured spans, or a placeholder while data is missing. */
    const bar = () => {
      const pending = behind()

      return (
        <box flexDirection="row" gap={0}>
          {line().length === 0 ? (
            <text fg={mutedFg()}>statusline: waiting for session</text>
          ) : (
            line().map((span) => (
              <text fg={span.muted ? mutedFg() : (span.color ?? baseFg())}>{span.text}</text>
            ))
          )}
          {pending > 0 ? <text fg={warningFg()}>{` \u2191${pending}`}</text> : null}
        </box>
      )
    }

    /**
     * The bar, rendered in the prompt footer: flush under the input by construction, with
     * no reserved rows.
     *
     * It does not survive the composer being replaced. The Subagents session panel takes
     * the whole composer, footer included, so the bar is absent while it is open. The
     * slash-command menu overlays the composer instead, so the bar stays.
     */
    const footerBar = () => bar()

    // The only slot this plugin owns.
    const registered: Array<() => void> = []

    try {
      // The bar lives here, flush under the input. It does not survive the composer being
      // replaced, which is the behaviour documented in README.md.
      registered.push(context.ui.slot({ replace: "prompt.footer", render: footerBar }))
    } catch (error) {
      context.ui.toast.show({ variant: "error", message: `statusline: prompt.footer failed: ${error}` })
    }

    return () => {
      clearTimeout(jitter)
      clearInterval(redraw)
      clearInterval(poll)

      for (const unregister of registered) {
        unregister()
      }
    }
  },
})