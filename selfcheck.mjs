/**
 * dsh-session-shift 自检：只验最容易坏的地方 ——
 *  1. 能不能拿到 @deepseek-ai/dsh-llm 的 createUserMessage（交接最后一步靠它）
 *  2. 能不能拿到 @deepseek-ai/dsh-tools 的 defineTool，并把 handoff_now 真正定义出来
 *  3. handoff_now 的 execute / 输出契约（六个键都在）、dryRun 分支、render 跑得通
 *  4. **apply 里注册工具那条线**：用假 ctx 真跑一次 apply，再调注册出来的那个工具
 *     （dryRun 只落盘、不建会话，所以假 ctx 够用）—— 这条专抓「参数没往下传」这类接线 bug
 *
 * 必须用 Electron 运行时跑：打包版把 @deepseek-ai/* 放在 app.asar 里，只有
 * Electron 的 fs 读得到。普通 node 跑必失败，那是环境不对，不是插件坏
 * （拿普通 node 跑时，失败输出末尾会直接把下面这条重跑命令打出来）。
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "<DSH 安装目录>\DeepSeek Harness.exe" "<本仓库>\selfcheck.mjs"
 *
 * link: 装法下换装法之前先断链：pnpm 的 remove 可能沿 junction 删除，删到仓库自身的文件。
 *   cmd /c rmdir "<profile 目录>\node_modules\dsh-session-shift"
 *   dsh plugin --profile <profile> add <新的装法>
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 真跑的时候 argv[1] 是 harness 入口；独立跑时补上，让被测代码路径和线上一致。
const hostEntry = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
if (!/dsh-desktop-host/.test(String(process.argv[1] || ''))) process.argv[1] = hostEntry

const REQUIRED = ['ok', 'dryRun', 'newSessionId', 'newTitle', 'filePath', 'error']

function checkKeys(value, label) {
  for (const key of REQUIRED) {
    if (!(key in value)) throw new Error(label + ' 输出缺键 ' + key + '：' + JSON.stringify(value))
  }
}

try {
  const mod = await import(new URL('./lib/index.js', import.meta.url))

  if (mod.name !== 'dsh-session-shift') throw new Error('name 不对：' + mod.name)
  if (typeof mod.apply !== 'function') throw new Error('apply 缺失')
  if (mod.apply.constructor.name !== 'AsyncFunction') throw new Error('apply 必须是 async（工具注册要 await）')
  if (!Array.isArray(mod.inject) || mod.inject.indexOf('tools') < 0) throw new Error('inject 缺 tools')

  const createUserMessage = await mod.loadCreateUserMessage()
  const message = createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })
  console.log('createUserMessage ok, message keys = ' + Object.keys(message).join(','))

  const defineTool = await mod.loadDefineTool()
  let seen = null
  const tool = defineTool(mod.handoffToolOptions(async (session, reason, cwd, dryRun) => {
    seen = { session, reason, cwd, dryRun }
    return dryRun
      ? { ok: true, dryRun: true, filePath: 'E:/x/handoff.md', newTitle: '标题（接 01:00）' }
      : { ok: true, newSessionId: 'session-fake', newTitle: '标题（接 01:00）', filePath: 'E:/x/handoff.md' }
  }))
  if (!tool || tool.name !== 'handoff_now') throw new Error('defineTool 返回不对：' + JSON.stringify(tool && tool.name))
  console.log('defineTool ok, keys = ' + Object.keys(tool).join(','))

  const exec = { agent: { session: { id: 'session-src' } }, cwd: 'E:/x' }

  const value = await tool.execute({ reason: '自检' }, exec)
  checkKeys(value, '真跑')
  if (value.ok !== true || value.dryRun !== false || value.newSessionId !== 'session-fake') throw new Error('真跑输出不对：' + JSON.stringify(value))
  if (!seen || seen.reason !== '自检' || seen.cwd !== 'E:/x' || !seen.session || seen.dryRun !== undefined) throw new Error('runOnce 入参不对：' + JSON.stringify(seen))
  const parts = tool.output.render({}, value)
  if (!Array.isArray(parts) || parts[0].type !== 'text' || !/^已交接/.test(parts[0].text)) throw new Error('真跑 render 不对：' + JSON.stringify(parts))
  console.log('真跑 ok: ' + parts[0].text.slice(0, 50))

  const dry = await tool.execute({ reason: '自检', dryRun: true }, exec)
  checkKeys(dry, '试跑')
  if (dry.ok !== true || dry.dryRun !== true || dry.newSessionId !== '') throw new Error('试跑输出不对：' + JSON.stringify(dry))
  if (!seen || seen.dryRun !== true) throw new Error('试跑没把 dryRun 传下去：' + JSON.stringify(seen))
  const dryParts = tool.output.render({}, dry)
  if (!/^试跑/.test(dryParts[0].text)) throw new Error('试跑 render 不对：' + dryParts[0].text)
  console.log('试跑 ok: ' + dryParts[0].text.slice(0, 50))

  const failed = tool.output.render({}, { ok: false, dryRun: false, newSessionId: '', newTitle: '', filePath: '', error: 'boom' })
  if (!/^交接失败/.test(failed[0].text)) throw new Error('失败 render 不对：' + failed[0].text)

  // ── 假 ctx 真跑 apply：验「注册出去的那个工具」的接线 ──────────────────────
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-session-shift-selfcheck-'))
  let registered = null
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register() {} } },
    tools: { register(t) { registered = t } },
    on() {},
    // 标题只挂在会话日志的 session/title 事件上，session 对象里没有 —— 这条钉住读取路径。
    // 注意形状：get() 返回的是 snapshot 对象 { title, messageSeqs, source, eventSeq, updatedAt }，
    // 不是字符串（漏了 .title 就会静默掉回兜底标题，线上真出过一次）。带上一轮的「（接 ..）」
    // 是为了同时钉住"重复交接不叠时间戳"。
    sessionTitle: { get: () => ({ title: '自检标题（接 01-02）', messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 0 }) },
  }
  await mod.apply(ctx, { enabled: false, handoffDir: outDir })
  if (!registered || registered.name !== 'handoff_now') throw new Error('apply 没注册出 handoff_now 工具')
  const session = {
    id: 'session-selftest-0000',
    // 这两个 tool/call 专钉「文件清单里的垃圾条目」：引号包住的整条命令、写进文件里的散文、
    // <you>/$id 占位串、带空格的真路径 —— 全都在线上真出过一次。
    snapshotEvents: () => [
      { type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'Get-Item "E:/AO/ao-mcp-launcher.mjs 存在吗: "' } } },
      { type: 'tool/call', data: { name: 'write', arguments: { file_path: 'E:/Legend of Lhoba/NewProject/a.txt', content: '见 E:/dsh-session-shift（工作区外），装到 C:/Users/<you>/.dsh/plugins/dsh-session-shift。' } } },
    ],
  }
  const wired = await registered.execute({ reason: '接线自检', dryRun: true }, { agent: { session }, cwd: outDir })
  checkKeys(wired, '假 ctx 试跑')
  if (wired.ok !== true || wired.dryRun !== true) throw new Error('假 ctx 试跑没走 dryRun 分支（十有八九是实现里没把参数传下去）：' + JSON.stringify(wired))
  if (!existsSync(wired.filePath)) throw new Error('交接包没落盘：' + wired.filePath)
  const body = readFileSync(wired.filePath, 'utf8')
  if (!body.startsWith('# 交接包')) throw new Error('交接包内容不对')
  if (!/接线自检/.test(body)) throw new Error('交接包没带上 reason')
  if (wired.newTitle.indexOf('自检标题') !== 0) throw new Error('标题没从 sessionTitle.get() 的 snapshot.title 读到（旧会话也就不会被加 [已交接]）：' + wired.newTitle)
  if (wired.newTitle !== '自检标题（接 1）') throw new Error('新会话标题不是「原标题（接 编号）」：' + wired.newTitle)
  // 文件清单：真路径要在，垃圾条目一个都不能有
  const listed = (body.match(/## 改动过的文件[\s\S]*?(?=\n## )/) || [''])[0]
    .split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
  for (const want of ['E:/AO/ao-mcp-launcher.mjs', 'E:/Legend of Lhoba/NewProject/a.txt']) {
    if (listed.indexOf(want) < 0) throw new Error('文件清单漏了 ' + want + '：' + listed.join(' | '))
  }
  const dirty = listed.filter((p) => /[（），。；：！？<>$]|[\\/]$/.test(p))
  if (dirty.length > 0) throw new Error('文件清单里有垃圾条目：' + dirty.join(' | '))
  console.log('文件清单 ok: ' + listed.join(' | '))
  console.log('假 ctx 试跑 ok: ' + wired.filePath + '（' + body.length + ' 字），新标题「' + wired.newTitle + '」')

  // ── 助手窗口：中间的决策句必须进包，纯工具轮不许占位，单条超长要截断 ──────
  const filler = '长'.repeat(3000)
  const chat = {
    id: 'session-chat-0000',
    snapshotEvents: () => [
      { type: 'user/message', data: { content: [{ type: 'text', text: '第一件事' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '决策：这里改用 ctx.inject 等晚注册服务，因为直接 get 拿不到。' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool_use', name: 'pwsh' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: filler }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最新一条：收尾。' }] } } },
    ],
  }
  const chatRun = await registered.execute({ reason: '窗口自检', dryRun: true }, { agent: { session: chat }, cwd: outDir })
  const chatBody = readFileSync(chatRun.filePath, 'utf8')
  const win = (chatBody.match(/## 最近助手消息[\s\S]*?(?=\n## )/) || [''])[0]
  if (!/决策：这里改用 ctx\.inject/.test(win)) throw new Error('助手窗口没带上中间的决策句：\n' + win)
  const entries = (win.match(/^- 【\d+】/gm) || []).length
  if (entries !== 2) throw new Error('助手窗口条数不对（纯工具轮不该占位，应为 2）：' + entries + '\n' + win)
  if (chatBody.indexOf('长'.repeat(1000)) >= 0) throw new Error('单条助手消息没按 perItem 截断，一条日志就能吃掉整个窗口')
  console.log('助手窗口 ok: 中间决策句在包里、纯工具轮未占位、单条已截断')

  // ── 保新弃旧：maxChars 收紧时丢的必须是更早的消息，最新的永远在 ──────────
  const budgetDir = mkdtempSync(join(tmpdir(), 'dsh-session-shift-budget-'))
  let budgetTool = null
  await mod.apply({
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register() {} } },
    tools: { register(t) { budgetTool = t } },
    on() {},
    sessionTitle: { get: () => undefined },
  }, { enabled: false, handoffDir: budgetDir, maxChars: 3000 })
  const many = []
  for (let i = 1; i <= 10; i += 1) {
    many.push({ type: 'user/message', data: { content: [{ type: 'text', text: '用户第 ' + i + ' 件事 ' + 'x'.repeat(200) }] } })
    many.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手第 ' + i + ' 轮：' + 'y'.repeat(300) }] } } })
  }
  const bigRun = await budgetTool.execute({ reason: '预算自检', dryRun: true }, { agent: { session: { id: 'session-budget', snapshotEvents: () => many } }, cwd: budgetDir })
  const bigBody = readFileSync(bigRun.filePath, 'utf8')
  if (bigBody.length > 3200) throw new Error('窗口预算没生效，交接包仍然超 maxChars：' + bigBody.length + ' 字（maxChars=3000）')
  if (!/助手第 10 轮/.test(bigBody)) throw new Error('保新弃旧失败：最新一条助手消息不在包里')
  if (!/助手第 9 轮/.test(bigBody)) throw new Error('保新弃旧失败：助手窗口连最新一条都没保住')
  if (/助手第 1 轮/.test(bigBody)) throw new Error('保新弃旧失败：最旧的助手消息还在，预算没起作用')
  if (!/因预算未列出/.test(bigBody)) throw new Error('丢了消息却没写明原因')
  console.log('保新弃旧 ok: 3000 字预算下「第 10/9 轮」在、「第 1 轮」不在，且写明了丢弃原因')

  // ── 空事件断言：读不到会话日志时必须失败，不许产出一份「全是（无）」的空壳包 ──
  const empty = await registered.execute({ reason: '空事件自检', dryRun: true }, { agent: { session: { id: 'session-empty', snapshotEvents: () => [] } }, cwd: outDir })
  checkKeys(empty, '空事件')
  if (empty.ok !== false) throw new Error('会话事件为空时没中止（会产出空壳交接包）：' + JSON.stringify(empty))
  if (empty.filePath !== '') throw new Error('空事件中止了却还是落了盘：' + empty.filePath)
  if (!/事件/.test(empty.error)) throw new Error('空事件的报错没说清原因：' + empty.error)
  console.log('空事件 ok: ' + empty.error)

  // ── 触发条件②：压力不达标、但会话已被压缩 ≥ maxCompactions 次时，必须自动交接 ──
  const triggerDir = mkdtempSync(join(tmpdir(), 'dsh-session-shift-trigger-'))
  let preStep = null
  const routes = new Map()
  const triggerCtx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    tools: { register() {} },
    on(name, fn) { if (name === 'agent/pre-step') preStep = fn },
    sessionTitle: { get: () => undefined, rename() {} },
    // 压力远低于阈值 —— 唯一能触发的理由只剩「已压缩 2 次」
    sessionProjections: { stateOf: () => ({ surfaceTokens: 10, contextWindow: 1000 }) },
  }
  await mod.apply(triggerCtx, { enabled: true, dryRun: true, maxCompactions: 2, thresholdRatio: 0.99, handoffDir: triggerDir })
  if (!preStep) throw new Error('apply（enabled=true）没挂 agent/pre-step')
  const squeezed = {
    id: 'session-squeezed',
    snapshotEvents: () => [
      { type: 'compaction/summary', data: { summary: '第一次压缩' } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '原来的待办' }] } },
      { type: 'compaction/summary', data: { summary: '第二次压缩' } },
    ],
  }
  await preStep({ agent: { session: squeezed }, signal: { aborted: false } }, async () => {})
  const statusRoute = routes.get('/api/handoff/status')
  if (!statusRoute) throw new Error('apply 没注册 /api/handoff/status')
  let fired = null
  for (let i = 0; i < 60; i += 1) {
    const snap = await (await statusRoute.fetch()).json()
    if (snap.autoRuns > 0 && snap.lastResult) { fired = snap; break }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!fired) throw new Error('压过 2 次、压力不达标时没有触发自动交接')
  const auto = fired.lastResult
  if (auto.ok !== true || auto.dryRun !== true) throw new Error('自动交接结果不对：' + JSON.stringify(auto))
  if (auto.compactions !== 2) throw new Error('自动交接没数出 2 次压缩：' + JSON.stringify(auto.compactions))
  const squeezedBody = readFileSync(auto.filePath, 'utf8')
  if (!/已被压缩：2 次/.test(squeezedBody)) throw new Error('交接包没写压缩次数')
  if (!/触发原因：auto: 本会话已被压缩 2 次/.test(squeezedBody)) throw new Error('交接包的触发原因不是压缩次数：' + squeezedBody.split('\n')[3])
  console.log('压缩触发 ok: ' + squeezedBody.split('\n')[3] + ' → ' + auto.filePath)

  // ── 重复触发：同一个会话只能自动交接一次 ──
  // 交接不清空老会话的上下文，所以 due 一旦为真就永远为真（「已压缩 ≥ N 次」只会越数越多）。
  // 没有终态时，唯一拦住重复的就是 cooldown —— cooldownMs=0 时会被交接 3 次、开出 3 个会话。
  const onceDir = mkdtempSync(join(tmpdir(), 'dsh-session-shift-once-'))
  let preStep2 = null
  const routes2 = new Map()
  let createdCount = 0
  const onceCtx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register(route) { routes2.set(route.path, route) } } },
    tools: { register() {} },
    on(name, fn) { if (name === 'agent/pre-step') preStep2 = fn },
    sessionTitle: { get: () => '原标题', rename() {} },
    sessionProjections: { stateOf: () => ({ surfaceTokens: 10, contextWindow: 1000 }) },
    agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => {} },
    permissionPresets: { defaultPreset: '', resolve() {}, set() {} },
    agentDefaultModel: { currentSelection: () => undefined },
    workspaceRegistry: { create: async (cwd) => ({ path: cwd, attachSession: async () => {}, detachSession: async () => {} }) },
    agents: { create: async () => { createdCount += 1; return { agent: { session: { id: 'session-new' }, followup() {} }, dispose: async () => {} } } },
  }
  await mod.apply(onceCtx, { enabled: true, maxCompactions: 2, thresholdRatio: 0.99, handoffDir: onceDir, cooldownMs: 0 })
  if (!preStep2) throw new Error('apply（重复触发用例）没挂 agent/pre-step')
  const repeated = {
    id: 'session-squeezed-again',
    snapshotEvents: () => [
      { type: 'compaction/summary', data: { summary: '压缩一' } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '待办' }] } },
      { type: 'compaction/summary', data: { summary: '压缩二' } },
    ],
  }
  const onceStatus = routes2.get('/api/handoff/status')
  if (!onceStatus) throw new Error('重复触发用例没注册 /api/handoff/status')
  await preStep2({ agent: { session: repeated }, signal: { aborted: false } }, async () => {})
  let onceSnap = null
  for (let i = 0; i < 80; i += 1) {
    onceSnap = await (await onceStatus.fetch()).json()
    if (onceSnap.doneSessions.includes(repeated.id)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!onceSnap.doneSessions.includes(repeated.id)) throw new Error('交接成功后没落终态（doneSessions=' + JSON.stringify(onceSnap.doneSessions) + '）')
  await new Promise((resolve) => setTimeout(resolve, 60))
  await preStep2({ agent: { session: repeated }, signal: { aborted: false } }, async () => {})
  await preStep2({ agent: { session: repeated }, signal: { aborted: false } }, async () => {})
  onceSnap = await (await onceStatus.fetch()).json()
  if (createdCount !== 1) throw new Error('cooldownMs=0 时同一个会话被交接了 ' + createdCount + ' 次（应为 1 次）')
  if (onceSnap.doneSkips < 2) throw new Error('后续 pre-step 没被终态拦下（doneSkips=' + onceSnap.doneSkips + '）')
  console.log('只交接一次 ok: 同一会话 3 次 pre-step → 建了 ' + createdCount + ' 个新会话，拦下 ' + onceSnap.doneSkips + ' 次')

  // ── 交接标题：① 编号递增、不叠括号 ② 交接后停老会话那一轮 ③ 被运行环境自动起名覆盖后写回 ──
  const titleDir = mkdtempSync(join(tmpdir(), 'dsh-session-shift-title-'))
  const squeezeEvents = () => [
    { type: 'compaction/summary', data: { summary: '一' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '待办' }] } },
    { type: 'compaction/summary', data: { summary: '二' } },
  ]
  const makeTitleCtx = (oldTitle) => {
    const rec = { renames: [], stops: [], created: 0, newTitleVal: '', step: null, stopping: null, tool: null, newSessionId: '' }
    rec.session = { id: 'session-title-old', snapshotEvents: squeezeEvents }
    rec.ctx = {
      logger: { info() {}, warn() {}, error() {} },
      connection: { fetch: { register() {} } },
      tools: { register(t) { rec.tool = t } },
      parallel: async (name, payload) => { rec.stops.push([name, payload && payload.sessionId]) },
      on(name, fn) { if (name === 'agent/pre-step') rec.step = fn; if (name === 'agent/turn-stopping') rec.stopping = fn },
      sessionTitle: {
        get: (s) => (s && s.id === rec.newSessionId ? (rec.newTitleVal || oldTitle) : oldTitle),
        rename(s, t) { rec.renames.push([s && s.id, t]); if (s && s.id === rec.newSessionId) rec.newTitleVal = t },
      },
      sessionProjections: { stateOf: () => ({ surfaceTokens: 10, contextWindow: 1000 }) },
      agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => {} },
      permissionPresets: { defaultPreset: '', resolve() {}, set() {} },
      agentDefaultModel: { currentSelection: () => undefined },
      workspaceRegistry: { create: async (cwd) => ({ path: cwd, attachSession: async () => {}, detachSession: async () => {} }) },
      agents: {
        create: async (opts) => {
          rec.created += 1
          rec.newSessionId = (opts && opts.sessionId) || 'session-new'
          return { agent: { session: { id: rec.newSessionId }, followup() {} }, dispose: async () => {} }
        },
      },
    }
    return rec
  }
  // ① 编号规则：走 dryRun（手动路径，不受「已交接」终态限制）
  const titleCases = [
    ['dsh-handoff（接 03-57） (1) [已交接]', 'dsh-handoff（接 2）'],
    ['codex额度工具', 'codex额度工具（接 1）'],
    ['标题（接 4）', '标题（接 5）'],
    ['', '会话交接（接 1）'],
  ]
  for (const [oldT, want] of titleCases) {
    const rec = makeTitleCtx(oldT)
    await mod.apply(rec.ctx, { enabled: true, handoffDir: titleDir, cooldownMs: 0 })
    const out = await rec.tool.execute({ reason: '标题自检', dryRun: true }, { agent: { session: rec.session }, cwd: titleDir })
    if (out.newTitle !== want) throw new Error('标题编号不对：旧「' + oldT + '」→「' + out.newTitle + '」（应为「' + want + '」）')
  }
  // ②③ 真跑一次（旧标题不含 [已交接]，才会被触发）：停老会话那一轮 + 新会话标题被覆盖后写回
  {
    const rec = makeTitleCtx('codex额度工具')
    await mod.apply(rec.ctx, { enabled: true, maxCompactions: 2, thresholdRatio: 0.99, handoffDir: titleDir, cooldownMs: 0 })
    await rec.step({ agent: { session: rec.session }, signal: { aborted: false } }, async () => {})
    for (let i = 0; i < 80 && rec.newTitleVal === ''; i += 1) await new Promise((r) => setTimeout(r, 50))
    if (rec.newTitleVal !== 'codex额度工具（接 1）') throw new Error('交接没建出「（接 1）」标题的新会话：' + rec.newTitleVal)
    if (rec.created !== 1) throw new Error('交接没有建新会话：' + rec.created)
    if (!rec.stops.some(([n, id]) => n === 'workspace/session-stop' && id === 'session-title-old')) {
      throw new Error('交接后没有停掉老会话那一轮（stops=' + JSON.stringify(rec.stops) + '）')
    }
    rec.newTitleVal = '被自动起名覆盖'
    await rec.step({ agent: { session: { id: rec.newSessionId, snapshotEvents: () => [] } }, signal: { aborted: false } }, async () => {})
    if (rec.newTitleVal !== 'codex额度工具（接 1）') throw new Error('第一步没写回标题：' + rec.newTitleVal)
    rec.newTitleVal = '又被覆盖'
    if (rec.stopping) await rec.stopping({ agent: { session: { id: rec.newSessionId } } })
    if (rec.newTitleVal !== 'codex额度工具（接 1）') throw new Error('turn-stopping 没写回标题：' + rec.newTitleVal)
    if (rec.stopping) {
      rec.newTitleVal = '第三次覆盖'
      await rec.stopping({ agent: { session: { id: rec.newSessionId } } })
      if (rec.newTitleVal !== '第三次覆盖') throw new Error('第一轮结束后还在抢标题（应当只写回一次，之后你自己改的名字不能被改回去）')
    }
  }
  console.log('交接标题 ok: 编号递增不叠括号（含时间戳式旧标题、空标题）；交接后已停老会话那一轮；被自动起名覆盖后写回一次且不再抢')

  // ── 终态要能跨重启：标题里已经有 [已交接] 的会话，重启后也不许再自动交接 ──
  // （内存里的 doneBySession 重启就没了；标题是插件自己加的，落盘在那儿。）
  let preStep3 = null
  let createdCount3 = 0
  const titledCtx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register() {} } },
    tools: { register() {} },
    on(name, fn) { if (name === 'agent/pre-step') preStep3 = fn },
    sessionTitle: { get: () => '原标题' + ' [已交接]', rename() {} },
    sessionProjections: { stateOf: () => ({ surfaceTokens: 10, contextWindow: 1000 }) },
    agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => {} },
    permissionPresets: { defaultPreset: '', resolve() {}, set() {} },
    agentDefaultModel: { currentSelection: () => undefined },
    workspaceRegistry: { create: async (cwd) => ({ path: cwd, attachSession: async () => {}, detachSession: async () => {} }) },
    agents: { create: async () => { createdCount3 += 1; return { agent: { session: { id: 'session-new-3' }, followup() {} }, dispose: async () => {} } } },
  }
  await mod.apply(titledCtx, { enabled: true, maxCompactions: 2, thresholdRatio: 0.99, handoffDir: onceDir, cooldownMs: 0 })
  if (!preStep3) throw new Error('apply（标题终态用例）没挂 agent/pre-step')
  await preStep3({ agent: { session: { id: 'session-already-handed', snapshotEvents: repeated.snapshotEvents } }, signal: { aborted: false } }, async () => {})
  await new Promise((resolve) => setTimeout(resolve, 80))
  if (createdCount3 !== 0) throw new Error('标题已带 [已交接] 的会话又被自动交接了 ' + createdCount3 + ' 次（重启后会复发）')
  console.log('标题终态 ok: 标题带 [已交接] 的会话不触发（跨重启有效）')

  // ── 事件改名的静默失败：有 compaction/start、但一次 summary 都没数到 → 不许触发，且必须告警 ──
  const renamed = {
    id: 'session-renamed',
    snapshotEvents: () => [
      { type: 'compaction/start', data: {} },
      { type: 'user/message', data: { content: [{ type: 'text', text: '待办' }] } },
      { type: 'compaction/start', data: {} },
      { type: 'compaction/end', data: {} },
    ],
  }
  await preStep({ agent: { session: renamed }, signal: { aborted: false } }, async () => {})
  await new Promise((resolve) => setTimeout(resolve, 150))
  const renamedSnap = await (await statusRoute.fetch()).json()
  if (!renamedSnap.compaction || renamedSnap.compaction.sessionId !== 'session-renamed') throw new Error('status 没带压缩计数：' + JSON.stringify(renamedSnap.compaction))
  if (renamedSnap.compaction.summaries !== 0 || renamedSnap.compaction.starts !== 2) throw new Error('压缩计数不对：' + JSON.stringify(renamedSnap.compaction))
  if (!/改名|失效/.test(renamedSnap.warning || '')) throw new Error('压缩事件改名时没有告警（会静默退化成只看压力）：' + JSON.stringify(renamedSnap.warning))
  if (renamedSnap.autoRuns !== fired.autoRuns) throw new Error('压缩事件改名后仍然触发了交接：' + renamedSnap.autoRuns)
  console.log('改名告警 ok: ' + renamedSnap.warning)
  rmSync(triggerDir, { recursive: true, force: true })

  // ── 客户端半边：假 window + 假 fetch + 假 ctx，验「轮询 → 切到新会话」这条线 ──
  const clientCode = readFileSync(new URL('./client/handoff-client.js', import.meta.url), 'utf8')

  async function runClient(label, makeCtx, sessionId) {
    let clientModule = null
    const store = new Map()
    const timers = new Map()
    let nextTimer = 0
    const fakeWindow = {
      __ModuleLoader__: { load(spec) { clientModule = spec.factory(() => ({})) } },
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
      },
      setInterval: (fn) => { nextTimer += 1; timers.set(nextTimer, fn); return nextTimer },
      clearInterval: (id) => { timers.delete(id) },
      setTimeout: (fn, ms) => { setTimeout(fn, ms) },
    }
    const calls = []
    const fakeFetch = async (url) => {
      calls.push(String(url))
      if (String(url).includes('/api/handoff/status')) {
        return { ok: true, json: async () => ({ ok: true, lastResult: { ok: true, dryRun: false, newSessionId: sessionId } }) }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const opened = []
    new Function('window', 'fetch', 'console', 'setTimeout', clientCode)(fakeWindow, fakeFetch, console, setTimeout)
    if (clientModule === null) throw new Error(label + '：客户端模块没有调用 window.__ModuleLoader__.load')
    if (typeof clientModule.apply !== 'function') throw new Error(label + '：客户端模块没导出 apply')
    if (clientModule.inject.indexOf('sessions') < 0) throw new Error(label + '：客户端模块没有 inject sessions')
    const ctx = makeCtx(opened)
    // ctx.effect 按 cordis 语义：调用 setup，把返回的清理函数留存（apply 当场执行清理是 bug）。
    const cleanups = []
    ctx.effect = (setup) => { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup) }
    clientModule.apply(ctx)
    for (let i = 0; i < 60 && opened.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    if (opened.length !== 1 || opened[0] !== sessionId) throw new Error(label + '：没有切到新会话：' + JSON.stringify(opened))
    if (!calls.includes('/api/handoff/status')) throw new Error(label + '：没有轮询 /api/handoff/status')
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (!calls.includes('/api/handoff/client')) throw new Error(label + '：没有把结果回报给宿主')
    if (store.get('dsh-session-shift.opened.v1:' + sessionId) !== '1') throw new Error(label + '：没记下「已切过」，下次会重复跳')
    if (timers.size === 0) throw new Error(label + '：apply 之后没有任何定时器在跑（清理函数是不是被当成 setup 执行了？）')
    console.log(label + ' ok: ' + sessionId + ' + 回报宿主')
  }

  // 首选路径：视图所有者的公开导航接口（官方 UiWorkspace.openSession），必须优先用它。
  await runClient('客户端首选 uiWorkspace.openSession', (opened) => ({
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => { opened.push(id) } }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { 'session-child-a': {} } }) } }
      return undefined
    },
  }), 'session-child-a')

  // 退回路径：只有 sessions.open（老版本形态），仍然要能切。
  await runClient('客户端退回 sessions.open', (opened) => ({
    sessions: { open: (id) => { opened.push(id) } },
  }), 'session-child-b')

  // 晚注册路径：apply 时 uiWorkspace 还不存在，靠 ctx.inject 等到它再开工。
  await runClient('客户端晚注册 uiWorkspace', (opened) => ({
    inject(deps, callback) {
      setTimeout(() => callback({ uiWorkspace: { openSession: (id) => { opened.push(id) } } }), 30)
    },
    get() { return undefined },
  }), 'session-child-c')



  rmSync(outDir, { recursive: true, force: true })

  console.log('SELFCHECK OK（argv[1]= ' + process.argv[1] + '）')
} catch (error) {
  console.error('SELFCHECK FAILED: ' + (error && error.stack ? error.stack : String(error)))
  // 最常见的失败不是插件坏，是拿普通 node 跑了：打包版把 @deepseek-ai/* 放在 app.asar 里，
  // 普通 node 的 fs 进不去（Electron 的 fs 打了 asar 补丁）。这里直接把重跑命令给出来。
  if (/MODULE_NOT_FOUND|app\.asar/.test(String((error && error.message) || ''))) {
    console.error('')
    console.error('环境不对：这份自检必须跑在 DSH 自己的 Electron 里（普通 node 读不到 app.asar）。重跑：')
    console.error('  $env:ELECTRON_RUN_AS_NODE=1')
    console.error('  & "<DSH 安装目录>\\DeepSeek Harness.exe" "' + fileURLToPath(import.meta.url) + '"')
  }
  process.exitCode = 1
}
