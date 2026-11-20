# Contributions to getpaseo/paseo

What [@vecyang1](https://github.com/vecyang1) has sent upstream to [getpaseo/paseo](https://github.com/getpaseo/paseo), and the local fixes that run until upstream ships them. Generated 2026-11-20 22:20 from GitHub by `paseo_upstream_ledger.py`.

## Pull requests

| # | Title | State | Opened |
|---|---|---|---|
| [#9277](https://github.com/getpaseo/paseo/pull/9277) | fix(agent): preserve running agents across shutdown in restart recovery | open | 2026-11-10 |
| [#9032](https://github.com/getpaseo/paseo/pull/9032) | fix(antigravity): settle answered turns with stale trajectory errors without restarting driver | closed | 2026-11-07 |

## Issues

| # | Title | State | Opened |
|---|---|---|---|
| [#10263](https://github.com/getpaseo/paseo/issues/10263) | feat(claude): show Workflow progress (task_progress.workflow_progress is dropped, so a Workflow pane shows only its description until the run ends) | open | 2026-11-20 |
| [#10196](https://github.com/getpaseo/paseo/issues/10196) | bug: [antigravity-provider] silent Working stall during consecutive API errors & /goal stop-hook retry loops | closed | 2026-11-19 |
| [#9939](https://github.com/getpaseo/paseo/issues/9939) | bug: antigravity-provider getCatalog() omits isDefault on every model, so default falls back to arbitrary models[0] | closed | 2026-11-17 |
| [#9938](https://github.com/getpaseo/paseo/issues/9938) | New workspace creates two workspaces and agents for one prompt when the host is slow | open | 2026-11-17 |
| [#9743](https://github.com/getpaseo/paseo/issues/9743) | bug(markdown): bare HTTP(S) auto-links swallow trailing/adjacent CJK punctuation (。，、（）【】) | closed | 2026-11-15 |
| [#9551](https://github.com/getpaseo/paseo/issues/9551) | bug: Cursor's Auto model (id default) cannot be selected; the agent starts on the CLI's last saved model | open | 2026-11-13 |
| [#9395](https://github.com/getpaseo/paseo/issues/9395) | bug(protocol,relay): failed tool_call null error freezes timeline validation & daemon status masks disconnected relay control | open | 2026-11-11 |
| [#9383](https://github.com/getpaseo/paseo/issues/9383) | bug(app): getCompactionMarkerLabel drops preTokens whenever trigger is manual or auto | closed | 2026-11-11 |
| [#9355](https://github.com/getpaseo/paseo/issues/9355) | feat(antigravity-provider): bridge Antigravity ask_question & teamwork_interviewer to Paseo native question permission UI | closed | 2026-11-11 |
| [#9312](https://github.com/getpaseo/paseo/issues/9312) | bug: [antigravity-provider] interrupt waits behind agy start, causing 'active run cancellation was not acknowledged' | closed | 2026-11-10 |
| [#9082](https://github.com/getpaseo/paseo/issues/9082) | feat(speech): allow custom STT model IDs in SpeechProviderSheet & use toFile() instead of chunked fs.createReadStream in OpenAISTT | open | 2026-11-08 |

## Issues and pull requests joined

| # | Title | State | Opened |
|---|---|---|---|
| [#9218](https://github.com/getpaseo/paseo/pull/9218) | feat(plugins): extend antigravity provider with modes, effort selector, slash commands, sandbox, rich tool diffs, and session listing | open | 2026-11-09 |
| [#8782](https://github.com/getpaseo/paseo/issues/8782) | bug: <br> inside a Markdown table cell breaks the table row | open | 2026-11-04 |
| [#8522](https://github.com/getpaseo/paseo/pull/8522) | feat(server): surface Paseo-discovered skills to ACP and plugin providers alike | open | 2026-11-02 |
| [#7649](https://github.com/getpaseo/paseo/pull/7649) | fix(antigravity): support slash commands and skill discovery | open | 2026-10-22 |
| [#7425](https://github.com/getpaseo/paseo/issues/7425) | bug: after one agy stream drop, every later Antigravity turn fails with the same "stream was interrupted" error, even when the reply completes | closed | 2026-10-19 |
| [#7148](https://github.com/getpaseo/paseo/issues/7148) | bug: Cursor agent fails to start with "Unknown model config option" when its thinking level is for another model | open | 2026-10-16 |

## Ideas started

| # | Title | Votes | Replies | Opened |
|---|---|---|---|---|
| [#10311](https://github.com/getpaseo/paseo/discussions/10311) | Antigravity provider: native /swarm live board (swarm_board sidecar), inline progress card, and Swarm Worker subagents | 1 | 0 | 2026-11-20 |
| [#10303](https://github.com/getpaseo/paseo/discussions/10303) | Markdown tables: horizontal drag-and-drop column reordering (with edge auto-scroll) and column resizing | 1 | 0 | 2026-11-20 |
| [#10288](https://github.com/getpaseo/paseo/discussions/10288) | File pane: show clickable file path breadcrumb bar directly under the file toolbar | 1 | 0 | 2026-11-20 |
| [#9472](https://github.com/getpaseo/paseo/discussions/9472) | Timeline: show token reduction (preTokens → postTokens) on compaction divider | 1 | 0 | 2026-11-12 |
| [#9449](https://github.com/getpaseo/paseo/discussions/9449) | Sidebar: configurable keyboard shortcuts to switch Grouping between Project and Status | 1 | 0 | 2026-11-12 |
| [#9403](https://github.com/getpaseo/paseo/discussions/9403) | New Workspace: configurable shortcut to open "Choose the project" while typing | 1 | 1 | 2026-11-11 |
| [#9399](https://github.com/getpaseo/paseo/discussions/9399) | Command Center (Cmd+K): a workspace with one agent is listed twice, under Workspaces and under Agents | 1 | 1 | 2026-11-11 |
| [#9178](https://github.com/getpaseo/paseo/discussions/9178) | Clipboard copy: keep clean plain text in text/plain (no ** asterisks in Beeper/LinkedIn/WeChat) while preserving rich HTML in text/html for Notion | 3 | 0 | 2026-11-09 |
| [#9127](https://github.com/getpaseo/paseo/discussions/9127) | Dictation: option to insert the transcript without sending (Enter / Cmd+D currently send) | 2 | 0 | 2026-11-08 |
| [#9069](https://github.com/getpaseo/paseo/discussions/9069) | Command Center (Cmd+K) & Quick Switcher: Direct Project-level Workspace Jump + Left Sidebar Auto-Scroll | 2 | 0 | 2026-11-08 |
| [#9068](https://github.com/getpaseo/paseo/discussions/9068) | Schedules UI: Show execution history (Runs / All runs) and 1-click drill-down into completed run sessions | 1 | 1 | 2026-11-08 |
| [#9065](https://github.com/getpaseo/paseo/discussions/9065) | Drag & drop folders onto the Workspaces sidebar to open or create a workspace | 2 | 0 | 2026-11-08 |

## Discussions joined

| # | Title | Votes | Replies | Opened |
|---|---|---|---|---|
| [#6292](https://github.com/getpaseo/paseo/discussions/6292) | Workflow: more local speech models (including Chinese) and migration to new OpenAI audio APIs | 1 | 3 | 2026-10-07 |
| [#6123](https://github.com/getpaseo/paseo/discussions/6123) | File preview tab: open with default app / reveal in file manager | 2 | 1 | 2026-10-05 |
| [#5896](https://github.com/getpaseo/paseo/discussions/5896) | Add pdf preview? | 7 | 4 | 2026-10-02 |
| [#4636](https://github.com/getpaseo/paseo/discussions/4636) | [FR] Support setting hotkey for "Rename workspace" | 1 | 1 | 2026-09-10 |

## Running locally until upstream lands

| Local patch | What it changes | Upstream | Upstream state |
|---|---|---|---|
| `settle_answered_errors` | A turn whose final reply arrived is settled as completed instead of failing on a repeated, already-recovered agy stream error. | [#7425](https://github.com/getpaseo/paseo/issues/7425), [PR #9032](https://github.com/getpaseo/paseo/pull/9032) | #7425 closed, #9032 closed |
| `fast_close` | Closing an agy session stops the process after 250 ms, so a send after a plugin reload no longer times out. | [#8267](https://github.com/getpaseo/paseo/issues/8267) | #8267 open |
| `history_replay` | A resumed Antigravity session shows its earlier conversation. | [#8463](https://github.com/getpaseo/paseo/issues/8463), [PR #7004](https://github.com/getpaseo/paseo/pull/7004) | #8463 closed, #7004 open |
| `slash_commands` | Antigravity sessions list and expand slash commands and skills. | [#7648](https://github.com/getpaseo/paseo/issues/7648) | #7648 closed |
| `lazy_resume / start_gate` | A daemon restart no longer starts one agy per restored session; starts are capped and each session gets its own request lane. | none filed | - |
| `startup_interrupt` | Interrupt during agy initialization bypasses serial request queue rather than failing with active run cancellation was not acknowledged. | [#9312](https://github.com/getpaseo/paseo/issues/9312) | #9312 closed |
| `compaction_context_token_labels` | Show token drop (preTokens -> postTokens) on compaction divider and provide circular context usage meter for Antigravity. | [#9383](https://github.com/getpaseo/paseo/issues/9383), [Discussion #9472](https://github.com/getpaseo/paseo/discussions/9472) | #9383 closed, #9472 open |
| `sidebar_grouping_shortcuts` | Configurable keyboard shortcuts (Cmd+Ctrl+P By Project / Cmd+Ctrl+S By Status) with native menu shortcut badges. | [Discussion #9449](https://github.com/getpaseo/paseo/discussions/9449) | #9449 open |
| `default_flash_is_default` | Mark newest non-tiered standard Flash (High) model (gemini-4-hydrogen-high) as isDefault: true in antigravity-provider catalog. | [#9939](https://github.com/getpaseo/paseo/issues/9939) | #9939 closed |
| `new_workspace_double_submit_guard` | Coalesce twin NewWorkspaceScreen submits / createWorkspace RPCs while storage/IPC is slow (delivered in file-inspector-finder). | [#9938](https://github.com/getpaseo/paseo/issues/9938) | #9938 open |
| `retry_loop_guard` | Surface live consecutive Antigravity API errors as throttled session.notice items and abort stuck /goal stop-hook or prolonged error retry loops cleanly. | [#10196](https://github.com/getpaseo/paseo/issues/10196) | #10196 closed |
| `claude_workflow_progress_card` | Claude Workflow runs show live phases, agents, tokens and latest step in place of the Workflow card (delivered in file-inspector-finder, read from Claude's run files). | [#10263](https://github.com/getpaseo/paseo/issues/10263) | #10263 open |
| `antigravity_native_swarm_board` | Native Antigravity /swarm & /run-workflow passthrough, <PASEO_SWARM_BOARD> coordinator awareness, members.json Swarm Worker (<role>) subagents with swarm_wait idle state, and zero-copy swarm_board proxy + live timeline card (delivered in file-inspector-finder v1.9.6). | [Discussion #10311](https://github.com/getpaseo/paseo/discussions/10311) | #10311 open |
