# dsh-push

[English](./README.md) | 简体中文

把 DeepSeek Harness 的 agent 生命周期通知推送到 Bark、飞书、企业微信、钉钉、ntfy 或通用 webhook。

> [`kiim-wong/dsh-push`](https://github.com/kiim-wong/dsh-push) 的维护分支，跟进当前 DeepSeek Harness 版本（cordis 4.0.x、`@deepseek-ai/dsh-*` 0.2.1-rc.3），并让通知模板可以读取对话标题。

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

### 模板变量

`titleTemplate` 渲染出 `title`，`template` 渲染出正文 `text`。两者共用同一组占位符，且 `template` 里还可以引用 `{{title}}`。

| 变量 | 含义 |
| --- | --- |
| `event` | `idle`、`interrupted`、`needInput` 或 `exit` |
| `status` | 本次运行的状态，例如 `已就绪` |
| `reason` | 推送原因 |
| `conversation` | 最新的对话标题；会话还没有标题时为空串 |
| `title` | 渲染后的 `titleTemplate`（仅正文模板可用） |
| `text` | 渲染后的正文（仅 webhook body 模板可用） |
| `cwd`、`project` | 工作目录及其末级目录名 |
| `duration` | 运行时长，例如 `1m30s` |
| `session`、`model` | 会话 id 与 `provider/model` |
| `host`、`time`、`date` | 主机名、本地 `HH:MM:SS` 与 `YYYY-MM-DD` |

`conversation` 取自会话日志里最新的 `session/title` 事件；宿主装有 `sessionTitle` 服务时优先走该服务。例如 `"titleTemplate": "{{conversation}} · {{status}}"` 就会把对话名作为推送标题。

## `/push` 命令

挂载命令服务时提供 `/push status`、`list`、`get`、`set`、`enable`、`disable`、`test`、`events`、`on` 和 `off`；裸 `/push` 与 `/push status` 等价。没有命令服务的 headless 组合仍会加载推送事件监听器。

## 限制

通知发送不重试；每个请求有独立超时和进程退出时的有界 flush。dsh 没有 pi 的会话 quit 事件，因此 `exit` 表示插件树拆卸，不表示某个 Web 会话关闭。推送正文不包含对话正文，只包含生命周期摘要。

渠道实现沿用 pi-agent-push 的协议与签名算法；本项目仅将事件和命令层适配为 Cordis。

## 开发

`src/` 是唯一事实来源，而 `lib/` 也提交进仓库 —— 因为从 git 安装不会执行构建。改动 `src/` 之后：

```sh
pnpm install
pnpm build
node test/run.ts
```

把重新生成的 `lib/` 和源码改动一起提交，否则 `github:` 安装会继续使用上一次的构建产物。npm 发布侧由 `pnpm prepublishOnly` 强制同样的顺序。
