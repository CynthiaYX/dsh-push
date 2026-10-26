# dsh-push

English | [简体中文](./README.zh-CN.md)

Push DeepSeek Harness agent lifecycle notifications to Bark, Feishu, WeCom, DingTalk, ntfy, or a generic webhook.

> Maintained fork of [`kiim-wong/dsh-push`](https://github.com/kiim-wong/dsh-push). It tracks current DeepSeek Harness releases (cordis 4.0.x, `@deepseek-ai/dsh-*` 0.2.1-rc.3).

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

## `/push` command

When the command service is mounted, dsh-push provides `/push status`, `list`, `get`, `set`, `enable`, `disable`, `test`, `events`, `on`, and `off`. Headless compositions without the command service still load the notification event listeners.

## Limitations

Notification delivery is not retried. Each request has an independent timeout, and process teardown uses a bounded flush. dsh has no equivalent of pi's session quit event, so `exit` means the plugin tree is being disposed, not that an individual web session closed. Notification bodies contain lifecycle summaries, not conversation content.

Channel implementations retain the protocols and signing algorithms from pi-agent-push. This package adapts only the event and command layers to Cordis.
