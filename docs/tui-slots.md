# TUI slots and the statusline

What was established about OpenCode's TUI slots while building this plugin, so the next
person does not repeat the investigation. Everything below was observed on OpenCode 2.3.0.

## The slots this plugin uses

`prompt.footer` only, replacing it with the bar. It sits inside the composer, flush under
the input.

The built-in footer is a **separate plugin**, `opencode.prompt.footer`. Its row sits directly
above the bar, so it is disabled in `cli.json`:

```json
"plugins": ["/path/to/opencode-statusline", "-opencode.prompt.footer"]
```

With that row gone there is a blank line between the input and the bar.

## What does not work

| slot | while a session panel is open | while an overlaying menu is open |
|---|---|---|
| `prompt.footer` | disposed with the composer; with `opencode.prompt.footer` enabled, the row left on screen is **that plugin's** stale frame | keeps rendering; the slash-command menu overlays the composer rather than replacing it |
| `app` | the contribution renders, then the panel's overlay clips it away entirely | clipped away |

Two attempts to get a bar with a gap above it in the Subagents panel, both failed:

1. A leading blank row in the footer while the panel is open. The bar moves **up into** the
   panel's rows and overlaps its content; the panel is not a flex sibling that shrinks.
2. The bar in the `app` slot, in normal flow, with a spacer row. The rows are claimed, then
   the overlay clips the bar away. It also regressed dialogs, which had been fine.

The `app` slot's rows are not subtracted from the content area, so it cannot be used as an
always-visible fallback.

## Signals that do not identify a panel

- `context.ui.panel.current()` returns `undefined` while the built-in Subagents panel is
  open.
- `context.keymap.mode.current()` returns only `composer`, `base` or `autocomplete`; there
  is no panel value.
- `context.keymap.active()` does change when the composer is replaced — the `Text Editing`
  group and `Submit input` vanish — but those are UI labels, not API. A `composerActive()`
  built on that was written, tried and removed.

## Upstream

Filed as <https://github.com/anomalyco/opencode/issues/63840>. The generic status-widget
request, #23539, was closed as completed pointing at the existing slot API, so this is
scoped to layout when the composer is replaced. `CONTRIBUTING.md` requires design approval
before an implementation PR, and bug-fix PRs must reference an issue.