# dsh-push

English | [简体中文](./README.zh-CN.md)

Push DeepSeek Harness agent lifecycle notifications to Bark, Feishu, WeCom, DingTalk, ntfy, or a generic webhook.

> Maintained fork of [`kiim-wong/dsh-push`](https://github.com/kiim-wong/dsh-push). It tracks current DeepSeek Harness releases (cordis 4.0.x, `@deepseek-ai/dsh-*` 0.2.1-rc.3) and adds conversation titles to the notification templates.

## Installation

Install from GitHub, pinning a commit:

```sh
dsh plugin --profile web add github:CynthiaYX/dsh-push#<sha>
```

This repository ships the prebuilt `lib/` alongside the sources, so installation needs no build script and no `allowBuilds` entry in the profile's `pnpm-workspace.yaml`.

The package mounts itself as `dsh-push` through `cordis.patch.yml`. It does not require changes to the dsh monorepo or write to the profile's patch configuration.

## Configuration

The default configuration path is `$DSH_HOME/dsh-push/config.json`. Set `DSH_PUSH_CONFIG` to use another path. Start with [`config.example.json`](./config.example.json). Environment variable references support `$VAR` and `${VAR}`. Logs are written to `push.log` in the configuration file's directory.

Each channel requires at least its type and destination. Keep secrets in the configuration file or environment variables, not in `cordis.patch.yml`.

Supported events are `idle`, `interrupted`, `needInput`, and `exit`. `minDurationSec` filters `idle` notifications but does not affect `interrupted` notifications. Subagents are excluded by default; set `includeSubagents: true` to include agents whose session header has `origin: "subagent"`.

### Template variables

`titleTemplate` produces `title`; `template` produces the body `text`. Both accept the same placeholders, and `template` may also use `{{title}}`.

| Variable | Meaning |
| --- | --- |
| `event` | `idle`, `interrupted`, `needInput`, or `exit` |
| `status` | Localized status of the run, e.g. `已就绪` |
| `reason` | Localized reason for the notification |
| `conversation` | Latest conversation title; empty until the session has one |
| `title` | Rendered `titleTemplate` (body template only) |
| `text` | Rendered body (webhook body templates only) |
| `cwd`, `project` | Working directory and its basename |
| `duration` | Run duration, e.g. `1m30s` |
| `session`, `model` | Session id and `provider/model` |
| `host`, `time`, `date` | Hostname, local `HH:MM:SS`, and `YYYY-MM-DD` |

`conversation` comes from the session's latest `session/title` event, read through the host's `sessionTitle` service when that service is mounted. For example, `"titleTemplate": "{{conversation}} · {{status}}"` pushes the conversation's name as the notification title.

## `/push` command

When the command service is mounted, dsh-push provides `/push status`, `list`, `get`, `set`, `enable`, `disable`, `test`, `events`, `on`, and `off`. Bare `/push` and `/push status` are the same command. Headless compositions without the command service still load the notification event listeners.

## Limitations

Notification delivery is not retried. Each request has an independent timeout, and process teardown uses a bounded flush. dsh has no equivalent of pi's session quit event, so `exit` means the plugin tree is being disposed, not that an individual web session closed. Notification bodies contain lifecycle summaries, not conversation content.

Channel implementations retain the protocols and signing algorithms from pi-agent-push. This package adapts only the event and command layers to Cordis.

## Development

`src/` is the source of truth and `lib/` is committed, because git-hosted installs run no build step. After changing anything under `src/`:

```sh
pnpm install
pnpm build
node test/run.ts
```

Commit the regenerated `lib/` together with the source change; otherwise a `github:` install keeps running the previous build. `pnpm prepublishOnly` enforces the same order for npm releases.
