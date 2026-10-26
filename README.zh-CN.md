# dsh-push

[English](./README.md) | 简体中文

把 DeepSeek Harness 的 agent 生命周期通知推送到 Bark、飞书、企业微信、钉钉、ntfy 或通用 webhook。

> [`kiim-wong/dsh-push`](https://github.com/kiim-wong/dsh-push) 的维护分支，跟进当前 DeepSeek Harness 版本（cordis 4.0.x、`@deepseek-ai/dsh-*` 0.2.1-rc.3）。

## 安装

从 GitHub 安装时使用提交固定的仓库地址：

```sh
dsh plugin --profile web add github:CynthiaYX/dsh-push#<sha>
```

仓库随源码一起发布构建好的 `lib/`，所以安装不需要执行构建脚本，也不需要往目标 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds` 白名单。

包会通过 `cordis.patch.yml` 挂载为 `dsh-push`，不需要修改 dsh monorepo，也不写入 profile 的 patch 配置。

## 配置

配置文件默认位于 `$DSH_HOME/dsh-push/config.json`；也可以用 `DSH_PUSH_CONFIG` 指定路径。可从 [`config.example.json`](./config.example.json) 开始。环境变量引用支持 `$VAR` 与 `${VAR}`，日志写入配置文件同目录的 `push.log`。

每个 channel 至少需要自己的类型和目标地址。敏感值只放配置文件或环境变量，不要放进 `cordis.patch.yml`。

支持的事件为 `idle`、`interrupted`、`needInput` 和 `exit`。`idle` 可通过 `minDurationSec` 过滤；`interrupted` 不受该过滤影响。默认不推送 subagent，设置 `includeSubagents: true` 才会包含会话头部 `origin` 为 `subagent` 的 agent。

## `/push` 命令

挂载命令服务时提供 `/push status`、`list`、`get`、`set`、`enable`、`disable`、`test`、`events`、`on` 和 `off`。没有命令服务的 headless 组合仍会加载推送事件监听器。

## 限制

通知发送不重试；每个请求有独立超时和进程退出时的有界 flush。dsh 没有 pi 的会话 quit 事件，因此 `exit` 表示插件树拆卸，不表示某个 Web 会话关闭。推送正文不包含对话正文，只包含生命周期摘要。

渠道实现沿用 pi-agent-push 的协议与签名算法；本项目仅将事件和命令层适配为 Cordis。
