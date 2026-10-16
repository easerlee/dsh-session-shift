# dsh-session-shift

[English](README.en.md) | 中文

DSH 插件：上下文压力到阈值时，把当前工作**交接给一个新会话**。

长会话到后段会退化（作者自测：约 70% 上下文后开始出现「只思考不输出」）。DSH 原生的 compaction 是
**就地压缩**——用摘要替换原文，历史被改写。本插件走另一条路：**开一个新会话 + 一份可审阅的
交接包**，旧会话原样留着。

- 按**真实上下文压力**触发，或按**本会话已被压缩的次数**触发（不是猜轮数）
- 交接包**从会话自身机械提取**（改动过的文件、用过的工具、最近几轮用户+助手消息、停在哪儿），落盘可审阅
- 桌面端 `handoff_now` 工具（支持 `dryRun` 试跑）/ web 端与命令行走 HTTP 接口
- 新会话建好后**界面自动切过去**（走 harness 的 `uiWorkspace.openSession`；web / 桌面端）
- 旧会话**只改名加 ` [已交接]`**，不归档不删除

## 和名字相近的插件有什么区别？

生态里有几个名字相近的插件（都叫 `dsh-session-handoff` 那一族）。按你要的东西挑：

| | 触发 | 交接内容 | 旧会话 |
|---|---|---|---|
| **本插件** | **自动**：上下文压力到阈值，或本会话被压缩到上限（默认 2 次） | **机械提取原文**——改动过的文件 / 用过的工具 / 最近几轮消息 / 停在哪儿，**不过模型** | 只改名加 ` [已交接]`，原文不动 |
| `WeiYe6/dsh-session-handoff` | 手动 `/handoff` | 由**模型**总结成摘要 | 新建会话注入摘要 |
| `snow-The/dsh-session-handoff` | 手动导出 / 恢复 | 结构化交接文档 + 上下文裁剪 | — |

一句话：**要"到点自己换班、交接包是原文不是摘要"，用这个；要"手动触发 + 模型总结"，用那些。**

## 权限与安全

装上以后它只会做这些事：

- 注册一个工具 `handoff_now`（支持 `dryRun`）+ 两个 HTTP 接口（`GET /api/handoff/status`、`POST /api/handoff/run`）
- 到阈值时**自动新建一个会话**，并把当前会话改名加 ` [已交接]`（**不删除、不归档、不动原文**）
- 只在本地写文件：项目的 `.dsh/handoff/`、`$DSH_HOME/handoff-client-report.json`
- **不联网、不外发任何数据、不读凭据**

两个容易被静态扫描误读的地方，说清楚：

- `cordis.patch.yml` 是 **DSH profile 的配置清单**（声明本插件作为一个 bundle 行挂载），**不是改运行时代码** —— 插件里的 `lib/`、`client/` 没有任何 monkey-patch
- `new Function` 只出现在 `selfcheck.mjs`（自检脚本：在假 `window` 里跑客户端代码验证逻辑），**运行时一行都没有**

## 运行环境

- 开发与验证环境：DSH 桌面端 **0.2.0-rc.2**
- 自动切会话依赖 harness 的 `uiWorkspace.openSession`；**没有该接口的较早版本不会切、也不报错**，
  原因会写进 `$DSH_HOME/handoff-client-report.json`（见「已知限制」）
- 不需要单独安装 Node —— 用的是 DSH 自带的运行时

## 安装

### 桌面端（profile `desktop`）

```cmd
"<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-session-shift
```

- `desktop` 是 Electron 保留的 profile，**只能用它自己那套内置命令**。别处装的 npm CLI 会直接拒绝：
  `error: profile "desktop" is managed exclusively by the Electron application`
- 先**打开过一次桌面端**（profile 才会被初始化），执行前**完全退出**它 —— profile 有写锁，不退出会一直等
- 桌面端 `$DSH_HOME` 默认是 `%USERPROFILE%\.dsh`，profile 目录即 `%USERPROFILE%\.dsh\profiles\desktop`

### web 端（profile `web`）

```bash
dsh plugin --profile web add dsh-session-shift
```

- `web` profile **首次使用时自动初始化**，不用手工建；目录是 `$DSH_HOME/profiles/web`
- web 端跑在独立 home 时（启动脚本里设了 `DSH_HOME`），要用**那一套**的 `dsh`/`dsh.cmd`，
  否则会装进另一个 home

### 两端都一样的地方

装完**重启对应的那一端**——bundle 列表只在启动时读一次。其余：

- npm 包名是 `dsh-session-shift`
- 一条命令会同时把包写进 profile 的 `dependencies` 和 `dsh.profile.bundles`，不用手动改文件
- 不走 npm 也行：`add github:easerlee/dsh-session-shift`（同样的代码，只是每次装都拉仓库）

确认挂上了（web 端 / 命令行）：

```bash
curl "http://127.0.0.1:<端口>/api/handoff/status"
# {"ok":true,...,"tool":"registered"}   ← tool 为 registered 说明 handoff_now 工具也注册成功
```

## 卸载

```cmd
:: 桌面端 —— 同样：先完全退出桌面端，再用它自己那套内置命令
"<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-session-shift
```

```bash
# web 端
dsh plugin --profile web remove dsh-session-shift
```

不想卸也可以**先关掉**：在 profile 的 `cordis.patch.yml` 里把 `enabled` 设成 `false`
——插件还在，只是不再自动交接（`handoff_now` 工具与 HTTP 接口仍可用）。

卸完同样要**重启那一端**。卸载不会动你已经生成的交接包（`.dsh/handoff/` 下的文件仍留着，
要清自己删）。

## 用法

### 桌面端：`handoff_now` 工具（推荐）

> 你：「帮我交接一下，换个新会话」
> agent：调 `handoff_now` → 返回新会话 id / 标题 / 交接包路径

第一次想先看交接包质量、不想真建会话：

```
handoff_now(dryRun: true)     # 只落盘，不建会话、不改旧会话名
```

### web 端 / 命令行：HTTP 接口

```bash
# 手动触发（不传 sessionId 就取最近一个活跃会话）
curl -X POST http://127.0.0.1:<端口>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"手动换会话"}'

# 状态与上次结果
curl http://127.0.0.1:<端口>/api/handoff/status
```

`dsh web` 地址栏里的 `?token=` 是凭证（先访问一次 `/` 让 cookie 落下来，之后 API 才认）；桌面端
没有地址栏，手动触发走上面的工具。

### 自动触发

**每个会话只自动交接一次**，条件是满足任一、且距上次交接超过 `cooldownMs`：

- 压力到 `thresholdRatio`
- **本会话已被压缩 `maxCompactions` 次**（默认 2）

第二个条件是必需的：compaction 每次都会把压力压回它自己的阈值以下，只看压力的话交接等不到触发点。
两边怎么配合，见下。

「只交接一次」是必需的：交接**不会清空老会话的上下文**，所以条件一旦满足就永远满足（「已压缩 N 次」只会越数越多）。
只靠 `cooldownMs` 拦的话，老会话会每 5 分钟再交接一次，每次都新开一个会话 —— 最后几个会话同时干同一件事。
触发成功的会话会被记下来（内存 + 标题里的 `[已交接]`，所以 DSH 重启后依然有效）。
想让它再自动交接（例如你手动改回了标题），把 `[已交接]` 从标题里去掉即可；`handoff_now` 手动触发任何时候都能用。

### 交接真正发生时的三件事（顺序也是这个）

1. **先把交接包落盘**（`.dsh/handoff/`）——这一步做完才动别的，所以不会丢活
2. **新会话标题**：`原标题（接 N）`，N = 旧标题里**最后一个编号 + 1**；历史遗留的 `（接 02-15）` 这种时间戳式后缀会被换成编号，**绝不会 `（）` 套 `（）`**。运行环境自己还有一套按内容自动起名（会把标题盖掉），插件在新会话的第一轮结束前写回一次，之后不再碰它 —— **你自己改的名字不会被抢回去**
3. **老会话**：标题加 ` [已交接]`，并**停掉它正在跑的那一轮**（见 `stopOldSession`）。老会话不停的话，它继续干、新会话拿着同一份交接包也干，两边会同时改同一批文件

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-session-shift
  config:
    enabled: true
    thresholdRatio: 0.85     # 出厂默认 0.6；与 compaction 一起用时调高
    maxCompactions: 2        # 本会话被 compaction 压过几次就交接（0 = 只看压力）
    cooldownMs: 300000
    handoffDir: .dsh/handoff
    recentMessages: 14
    maxChars: 24000
    renameOldSuffix: " [已交接]"
    dryRun: false
    stopOldSession: true     # 交接完成后停掉老会话当前那一轮（和界面「停止」同一条路径）
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就只留 HTTP 接口与工具，不做自动交接 |
| `thresholdRatio` | `0.6` | 压力到多少比例触发（0.6 = 60%）。与 compaction 一起用时调高，见下 |
| `maxCompactions` | `2` | 本会话被 compaction 压过几次就触发交接（`0` = 只看压力） |
| `cooldownMs` | `300000` | 同一会话两次交接的最小间隔（自动交接本身每会话只做一次；这条主要给 `dryRun` 预演节流） |
| `handoffDir` | `.dsh/handoff` | 交接包落盘目录（相对工作区；写绝对路径也行） |
| `recentMessages` | `14` | 用户消息段最多带多少条（每条截 400 字） |
| `maxChars` | `24000` | 交接包字数上限；余量按预算分给两个消息窗口，塞不下先丢更早的 |
| `renameOldSuffix` | ` [已交接]` | 旧会话改名时加的后缀 |
| `dryRun` | `false` | **true = 只生成交接包，不建新会话**（首次验证用） |
| `stopOldSession` | `true` | 交接完成后**停掉老会话正在跑的那一轮**（走 harness 的 `workspace/session-stop`，和界面上的「停止」同一条路径；不归档、不删会话）。设 `false` 就让老会话继续跑 |

⚠️ patch 的 `config` 是**整段替换**，覆盖时必须把不想改的键一起写上。

助手消息段没有单独的条数配置：它吃用户消息段之后剩下的预算，**从最新往回填**，每条最多 600 字；
预算不够时丢掉的永远是更早的消息，最新的那条一定在（它就是「停在哪儿」）。

## 交接包里有什么

落盘文件是 Markdown，四块内容，全部从会话自身**机械提取**，不经过模型：

| 块 | 内容 |
|---|---|
| 改动过的文件 | 本会话动过的路径（最多 120 条） |
| 用过的工具（次数） | 按调用次数排序的前 12 个工具 |
| 最近几轮消息 | 用户消息段 + 助手消息段，各按预算从新往旧填，塞不下先丢更早的 |
| 停在哪儿 | 最后一条助手消息（截 2000 字）——接手方从这里开始 |

## 与 compaction 的关系

两个都开着时，**阈值不同**：

| | 阈值 | 行为 |
|---|---|---|
| `compaction-basic` | `0.6`（默认） | 就地压缩，会话继续用 |
| `dsh-session-shift` | `0.85`（建议值，高于 compaction） | 开新会话交接 |

插件出厂默认也是 `0.6`，和 compaction 的默认阈值相同。两个都开着时，compaction 每次都会先把压力压回
自己的阈值以下，所以只看压力的话**交接等不到触发点**。交接因此还看压缩次数：本会话被压过
`maxCompactions` 次（默认 2）就换班——compaction 管日常，压够了就交出去。

想让 handoff 当主力（不看压缩次数、纯按压力交接）：把 `compaction-basic` 设回 `disabled: true`，
`maxCompactions` 设 `0`，`thresholdRatio` 保持默认的 `0.6`。

## 已知限制

1. **自动切会话需要 harness 提供导航接口**——走 `uiWorkspace.openSession`；该接口不存在时
   （较老的 harness）就不切，也不报错，`$DSH_HOME/handoff-client-report.json` 里会写明原因
2. **交接包是机械提取的原文摘录，不做模型总结**——四块内容：动过的文件、用过的工具（含次数）、
   近几轮用户/助手消息、停在哪。助手消息里的决策句就是原始决策记录，但「哪条才是关键」要接手方自己判断
3. 旧会话只改名不归档（有意）
4. HTTP 接口只作用于**该宿主进程里活跃的会话**：刚起来、还没开过会话的实例会返回
   `没有可用会话（session 缺失）`
5. **生态里有几个名字相近的插件**：`WeiYe6/dsh-session-handoff`（手动 `/handoff`、摘要由模型生成）、
   `snow-The/dsh-session-handoff`（结构化交接文档 + 上下文裁剪）等；区别见上文「和名字相近的插件有什么区别？」

## License

MIT
