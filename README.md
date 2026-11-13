# opencode-statusline

An OpenCode TUI statusline in the style of a shell prompt:

```
~/git/adventurehound/app-spines (main *) 12% 120k/1M - 4m32s
```

field | from
--- | ---
`~/git/...` | the session's folder, home shortened to `~`
`(main *)` | git's own `__git_ps1`, so it matches a bash prompt
`12% 120k/1M` | context window used and the token counts, colored from 20/35/50/70%
`4m32s` | time since the session started

`model` and `thinking` are available but left out by default, because the TUI already shows
the model and its variant in the composer. Add them to `sections` to draw them here instead;
the provider rides along inside the model section as
`DeepSeek V4.1 Flash (Alibaba Token Plan)`.

## Layout

file | what it is
--- | ---
`tui.tsx` | the TUI plugin: gathers the session's data, runs the formatter, renders the ANSI it prints
`bin/opencode-statusline` | the formatter, Perl
`statusline.example.jsonc` | an example of what the line contains: sections, labels, separators, colors
`t/formatter.t` | regression tests for the formatter's output
`docs/tui-slots.md` | what OpenCode's TUI slots do and do not allow (the short version)

The formatter is not reimplemented in TypeScript. `tui.tsx` sends the session's details as
JSON on STDIN and turns the one colored line it prints back into spans. Everything about
the *shape* of the line therefore lives in the formatter's config — by default
`$XDG_CONFIG_HOME/opencode-statusline/config.jsonc` — which is the formatter's own
config format: comments allowed, and any setting left out keeps its default.

## Requirements

- OpenCode v2 with TUI plugin support
- perl 5.14+, using only modules that ship with it: `JSON::PP`, `Encode`, `Carp`,
  `List::Util`, `POSIX` and `Time::HiRes`. Nothing needs installing from CPAN.
- git's prompt helper, for the branch — usually `/usr/lib/git-core/git-sh-prompt`. Without
  it, everything works except the branch, which is left out.

## Install

Point `cli.json` at this directory:

```json
{
  "plugins": [
    "/home/YOU/git/renderorange/opencode-statusline",
    "-opencode.prompt.footer"
  ]
}
```

The second entry disables the built-in footer row, which otherwise sits directly above the
bar; see [Where it draws](#where-it-draws).

`cli.json` lives at `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`).
Settings hot-reload; `/reload` forces it. Nothing needs installing, and nothing is
published to npm.

Two environment variables override the defaults:

variable | default
--- | ---
`OPENCODE_STATUSLINE_SCRIPT` | `bin/opencode-statusline`, beside `tui.tsx`
`OPENCODE_STATUSLINE_CONFIG` | `$XDG_CONFIG_HOME/opencode-statusline/config.jsonc`, then `~/.config/opencode-statusline/config.jsonc`

## Configuring the line

Nothing needs a config file: without one, the formatter draws its built-in default (dir, git,
then model/context/cache/cost/time in brackets). To take control, copy the example:

```sh
mkdir -p ~/.config/opencode-statusline
cp statusline.example.jsonc ~/.config/opencode-statusline/config.jsonc
```

The example is the layout this repo was built around. Edit the copy, not the example.

The file is **JSONC**: comments are genuinely supported, because the formatter decodes with
`JSON::PP`'s `relaxed` mode. That accepts `/* block */` comments, `//` line comments, `#`
line comments, and a trailing comma before a closing bracket. `/* */` is the form that
editors and `jsonc` tooling understand, so prefer it.

```jsonc
"sections": ["dir", "git", { "sections": ["context", "time"], "separator": " - " }]
```

Available sections: `dir`, `git`, `model`, `context`, `cache`, `cost`, `time`, plus any
name defined under `commands`. `thinking` is a command, not a built-in: it reads `.thinking`
out of the JSON the plugin sends, and prints nothing at the model default, which drops the
field and its separator.

Color thresholds are a list; the entry with the highest `at` that the number has reached
wins, and `at` compares the rounded, displayed value:

```json
"colors": {
  "context": [
    { "color": "#ff3030", "at": 20 },
    { "color": "#ff8700", "at": 35 },
    { "color": "#ff69b4", "at": 50 },
    { "color": "#af5fff", "at": 70 }
  ]
}
```

`at` is a percentage for `context` and `cache`, and dollars for `cost`. Only one entry may
omit `at`, and it is the color below every threshold. Two entries cannot share an `at`. A
bad value prints a message into the statusline instead of the line.

These thresholds are scaled for a 1,000,000-token window; the upstream defaults (45/60/75/90)
assume about 200k.

### Token counts

`context.tokens` adds the counts after the percent:

```json
"context": { "tokens": 1 }
```

```
16% 163k/1M
```

The count reads `963` below a thousand, `163k` to a million, then `1M`, `1.5M`. Without a
limit from the model, only the used count is shown (`16% 163k`). Only the **percent** is
colored; the counts are drawn in the muted color. Set `tokens` to `0` for the bare percentage.

### Muted sections

`muted` lists sections drawn in the theme's muted text color, so the eye lands on the number
that matters:

```json
"muted": ["time"]
```

The token counts are always muted. Muting uses the terminal's bright black (`90`), which the
plugin maps to OpenCode's own muted text token rather than a fixed grey.

A group can dim its separators too, so the whole tail reads as one block:

```json
{ "sections": ["context", "time"], "separator": " - ", "muted_separator": 1 }
```

`muted_separator` affects only the text *between* the group's sections, not the sections
themselves, and not a group's `before`/`after`.

### Every setting

Any key the formatter does not know is an error, reported in place of the line, so this is
the complete list.

key | what it is
--- | ---
`sections` | list of section names and groups. A group is an object with its own `sections`, plus optional `separator`, `before`, `after` and `muted_separator`
`separator` | text between top-level sections, default one space
`labels` | object of section name to the text drawn in front of it, e.g. `{"model": "model:"}`
`context.tokens` | `1` appends the token counts to the percent; `0` (default) draws the percent alone
`muted` | list of sections drawn in the muted colour
`git.format` | what `__git_ps1` is asked to print, default `(%s)`
`git.script` | path to git's prompt helper, when it is not in a standard location
`git.env` | object of extra environment variables for the prompt helper, e.g. `GIT_PS1_SHOWUNTRACKEDFILES`
`commands` | object of section name to `{"run": "<shell command>", "timeout": <seconds>}`; the command gets the session JSON on STDIN and its first output line is the section
`colors` | object of section name to a colour or a list of colours with `at` thresholds

A colour is `{"color": "#rrggbb"}` and may add `at` (a number) to apply only from that value
up. `commands.<name>.timeout` defaults to 1 second.

## Trying the formatter by hand

The quickest way to check a layout or color change without touching the TUI:

```sh
cd ~/git/renderorange/opencode-statusline
printf '%s' '{"workspace":{"current_dir":"'"$PWD"'"},"model":{"display_name":"X"},"thinking":"high","context_window":{"used_percentage":46,"used_tokens":163000,"limit_tokens":1000000},"cost":{"total_duration_ms":272000}}' \
  | bin/opencode-statusline | cat -v
```

The JSON this accepts is:

key | meaning
--- | ---
`workspace.current_dir`, or top-level `cwd` | folder, for `dir` and the git lookup
`model.display_name` | model, provider included by the plugin as `Name (Provider)`
`context_window.used_percentage` | percent, from the last assistant message's tokens
`context_window.used_tokens` / `limit_tokens` | the counts shown after the percent by `context.tokens`
`context_window.current_usage` | token counts, used to derive the cache hit rate
`prompt_cache.hit_ratio` | fraction, overrides the derived cache rate
`cost.total_duration_ms` | session age, for `time`
`cost.total_cost_usd`, `cost.total_lines_added/removed` | for `cost` and any command that wants them
`thinking` | the model variant, read by the `thinking` command

## Tests

The formatter's output is pinned byte for byte, including its escape sequences:

```sh
prove -r t      # or: npm test
```

The plugin itself needs the OpenCode host and has no automated test.

## Updates

Once an `origin` exists, the plugin asks it for new commits at most once a day (npm's
`update-notifier` interval), jitters the first check by up to two minutes, and caches the
answer in plugin storage so restarts don't re-fetch. When the checkout is behind, the line
gains ` ↑N` and a toast appears. Nothing is pulled automatically.

This checkout has an `origin` (`renderorange/opencode-statusline`), so the check runs once a
day once `origin/main` is fetched.

Offline, no remote, no credentials, or a detached HEAD all mean no marker — never an error.
Adding a remote takes effect on the next launch rather than after the interval.

## Where it draws

The bar replaces the built-in `prompt.footer`, which lives inside the composer, so it sits
directly under the input with no offset arithmetic. It is the only slot this plugin uses.

The built-in footer is a separate plugin, and its row sits above the bar. Disable it or you
get two rows:

```json
{
  "plugins": [
    "/home/YOU/git/renderorange/opencode-statusline",
    "-opencode.prompt.footer"
  ]
}
```

With that row gone, there is a blank line between the input and the bar. Disabling is the
documented `-id` form of the plugin list; `opencode.prompt.footer` is the built-in footer's
own id, which is not in the docs but is what the row belongs to.

Because the bar is inside the composer, it is **absent** while a session panel (the
Subagents view) has replaced the composer. A menu that overlays the composer instead — the
slash-command menu — leaves the bar in place. No documented slot survives a replacement:
`app` contributions render, but the panel's overlay clips them away. This is an upstream
limitation, recorded in `tmp/docs/upstream-issue-draft.md`, not a layout choice made here.

## Cost

The formatter runs once a second (`REFRESH_MS`), including one `git` call with
`GIT_OPTIONAL_LOCKS=0` so it never takes git's index lock. git is capped at one second and
the script caps its own output, so a slow repo drops the branch rather than the whole line.

## License

MIT.