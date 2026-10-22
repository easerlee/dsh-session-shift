/**
 * dsh-session-shift —— 上下文压力到阈值时，把当前工作交接给一个**新会话**。
 *
 * 与同类社区插件的差异：
 *  1. 交接包**从会话自身提取**（改动过的文件、最近对话、停在哪儿），不依赖任何
 *     个人记忆档案体系；同时落盘成文件，可人工审阅、可追溯。
 *  2. 触发依据是**真实上下文压力**（contextPressure 投影的 surfaceTokens/contextWindow），
 *     不是猜的轮数或固定条数。
 *  3. **单插件自洽**：不依赖未发布的配套插件。
 *  4. **优雅降级**：只把新会话建好、把交接包发进去；界面切换由使用者手动完成，
 *     结果里会给新会话 id 与标题。
 *  5. 旧会话**只改名加标记，不归档不删除**。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-session-shift'

export const inject = [
  'connection',
  'agents',
  'agentPresets',
  'permissionPresets',
  'agentDefaultModel',
  'sessionTitle',
  'workspaceRegistry',
  'sessionProjections',
  'tools',
]

const BS = String.fromCharCode(92)
const TAB = String.fromCharCode(9)
const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const SP = String.fromCharCode(32)
const BT = String.fromCharCode(96)
const DQ = String.fromCharCode(34)
const SQ = String.fromCharCode(39)

const DEFAULTS = {
  enabled: true,
  thresholdRatio: 0.6,
  maxCompactions: 2,
  cooldownMs: 300000,
  handoffDir: '.dsh/handoff',
  recentMessages: 14,
  maxChars: 24000,
  renameOldSuffix: ' [已交接]',
  dryRun: false,
  stopOldSession: true,
  liveGraceMs: 60000,
}

const KEYS = Object.keys(DEFAULTS)

function resolveConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('dsh-session-shift: config 必须是对象')
  for (const key of Object.keys(source)) {
    if (KEYS.indexOf(key) < 0) throw new Error('dsh-session-shift: 未知配置键 ' + key + '（允许：' + KEYS.join(', ') + '）')
  }
  const cfg = {}
  for (const key of KEYS) cfg[key] = source[key] === undefined ? DEFAULTS[key] : source[key]
  if (typeof cfg.enabled !== 'boolean') throw new Error('dsh-session-shift: enabled 必须是布尔值')
  if (typeof cfg.dryRun !== 'boolean') throw new Error('dsh-session-shift: dryRun 必须是布尔值')
  if (typeof cfg.thresholdRatio !== 'number' || !(cfg.thresholdRatio > 0 && cfg.thresholdRatio <= 1)) throw new Error('dsh-session-shift: thresholdRatio 必须是 (0, 1] 之间的数')
  if (!Number.isInteger(cfg.maxCompactions) || cfg.maxCompactions < 0) throw new Error('dsh-session-shift: maxCompactions 必须是非负整数（0 = 只看压力）')
  if (typeof cfg.cooldownMs !== 'number' || cfg.cooldownMs < 0) throw new Error('dsh-session-shift: cooldownMs 必须是非负数')
  if (typeof cfg.handoffDir !== 'string' || cfg.handoffDir.trim() === '') throw new Error('dsh-session-shift: handoffDir 必须是非空字符串')
  if (!Number.isInteger(cfg.recentMessages) || cfg.recentMessages < 0) throw new Error('dsh-session-shift: recentMessages 必须是非负整数')
  if (!Number.isInteger(cfg.maxChars) || cfg.maxChars < 1000) throw new Error('dsh-session-shift: maxChars 必须是不小于 1000 的整数')
  if (typeof cfg.renameOldSuffix !== 'string') throw new Error('dsh-session-shift: renameOldSuffix 必须是字符串')
  if (typeof cfg.liveGraceMs !== 'number' || !(cfg.liveGraceMs >= 0)) throw new Error('dsh-session-shift: liveGraceMs 必须是非负数')
  return cfg
}

// ── 事件与文本 ────────────────────────────────────────────────────────────

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') out += part.text
  }
  return out
}

function readEvents(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return []
    const raw = session.snapshotEvents()
    if (Array.isArray(raw)) return raw
    if (raw && Array.isArray(raw.events)) return raw.events
  } catch {
    return []
  }
  return []
}

/**
 * 数会话日志里的压缩事件（从第 from 个开始，增量用）。
 * summary = 历史被换成摘要那一次（有损，触发条件认它）；start = 压缩开始，用来识别事件改名。
 */
function scanCompaction(events, from) {
  let summaries = 0
  let starts = 0
  for (let i = from; i < events.length; i++) {
    const e = events[i]
    if (!e) continue
    if (e.type === 'compaction/summary') summaries += 1
    else if (e.type === 'compaction/start') starts += 1
  }
  return { summaries, starts }
}

/** 本会话被 compaction 压过几次 —— 交接包头部用（全量扫）。 */
function countCompactions(events) {
  return scanCompaction(events, 0).summaries
}

/**
 * 触发判定用的计数：日志只增不减，所以只扫上次之后新增的那一段。
 * （交接包正文用 runHandoff 里那次全量扫，这里只服务「压过几次」这个触发条件。）
 */
function compactionsSince(session, sid, state) {
  let st = state.compactionScan.get(sid)
  if (!st) { st = { seen: 0, count: 0, starts: 0 }; state.compactionScan.set(sid, st) }
  const events = readEvents(session)
  if (events.length < st.seen) { st.seen = 0; st.count = 0; st.starts = 0 }
  const delta = scanCompaction(events, st.seen)
  st.count += delta.summaries
  st.starts += delta.starts
  st.seen = events.length
  return { count: st.count, starts: st.starts }
}

/**
 * 压缩事件的静默失败检查：有压缩开始、却一次 summary 都没数到，
 * 说明 harness 改了事件名 —— 这时「已压缩 N 次」这条触发条件已经失效（只剩压力），
 * 必须说出来，不能悄悄退化成只看压力。
 */
function compactionWarning(scan) {
  if (scan.starts > 0 && scan.count === 0) {
    return '会话里有 ' + scan.starts + ' 次 compaction/start 但 0 次 compaction/summary：'
      + '压缩事件可能改名了，「已压缩 N 次」这条触发条件已失效（只剩压力）'
  }
  return ''
}

function isQuote(ch) {
  return ch === DQ || ch === SQ || ch === BT
}

function isSeparator(ch) {
  if (ch === SP || ch === TAB || ch === NL || ch === CR) return true
  return '|<>*?,;()[]{}'.indexOf(ch) >= 0
}

/**
 * 按空白与标点分词，但**引号内的内容整体算一个 token**。
 * 这条是必须的：Windows 路径常含空格（E:/The Paradise Protocol/...），
 * 调用方通常写成 "E:/The Paradise Protocol/..."，按空格硬切会得到 "E:/The" 这种残片。
 */
function tokenize(text) {
  const out = []
  let cur = ''
  let quote = ''
  for (const ch of String(text)) {
    if (quote !== '') {
      if (ch === quote) {
        if (cur !== '') { out.push(cur); cur = '' }
        quote = ''
      } else cur += ch
      continue
    }
    if (isQuote(ch)) { quote = ch; continue }
    if (isSeparator(ch)) {
      if (cur !== '') { out.push(cur); cur = '' }
    } else cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

function isAbsPath(token) {
  if (token.length < 4) return false
  if (token[1] !== ':') return false
  if (token[2] !== '/' && token[2] !== BS) return false
  const c = token[0]
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

function toDisplayPath(p) {
  let s = String(p)
  const doubled = BS + BS
  while (s.indexOf(doubled) >= 0) s = s.split(doubled).join(BS)
  return s.split(BS).join('/')
}

// 绝不会出现在路径里的字符（不含盘符的 ':'、不含空格 —— "E:/Legend of Lhoba/..." 是合法路径；
// 也不含汉字 —— 中文目录名是合法的）
const PATH_CUT = /[\n\r\t"'`<>|$*?&%（）《》，。；：！？、「」]/
const HAS_CJK = /[\u3400-\u9fff]/

function collectPathsFromString(text, paths) {
  for (const token of tokenize(text)) {
    if (!isAbsPath(token)) continue
    // 引号里的整条命令/整段文件内容会整体成为一个 token，这里再切回真正的路径：
    // 先切掉后面跟着的说明文字（"E:/AO/x.mjs 存在吗: "、写进文件里的散文），
    let cleaned = token
    const cut = cleaned.search(PATH_CUT)
    if (cut >= 0) cleaned = cleaned.slice(0, cut)
    if (HAS_CJK.test(cleaned) && /\s/.test(cleaned)) cleaned = cleaned.split(/\s+/)[0]
    while (cleaned.length > 0 && '.,;: \t'.indexOf(cleaned[cleaned.length - 1]) >= 0) cleaned = cleaned.slice(0, -1)
    // 截断后只剩目录前缀的（"C:/Users/<you>/..."、".../sessions/$id.json"）是占位串，不是路径
    if (cleaned.length > 3 && !/[\\/]$/.test(cleaned)) paths.add(toDisplayPath(cleaned))
  }
}

const PATH_KEYS = ['path', 'file_path', 'filepath', 'file', 'target', 'source', 'dest', 'destination', 'dir', 'directory', 'output', 'cwd', 'workdir']

function walkArgs(value, paths, depth) {
  if (depth > 8) return
  if (typeof value === 'string') { collectPathsFromString(value, paths); return }
  if (Array.isArray(value)) { for (const item of value) walkArgs(item, paths, depth + 1); return }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (typeof child === 'string' && PATH_KEYS.indexOf(String(key).toLowerCase()) >= 0) {
        const t = child.trim()
        if (t !== '') paths.add(toDisplayPath(t))
      } else walkArgs(child, paths, depth + 1)
    }
  }
}

function collectMaterial(events) {
  const paths = new Set()
  const users = []
  const assistants = []
  const tools = new Map()
  let model = ''
  const start = Math.max(0, events.length - 4000)
  for (let i = start; i < events.length; i++) {
    const e = events[i]
    if (!e || typeof e !== 'object') continue
    if (e.type === 'user/message') {
      const t = textOf(e.data ? e.data.content : undefined).trim()
      if (t !== '') users.push(t)
      continue
    }
    if (e.type === 'assistant/message') {
      const msg = e.data ? e.data.message : undefined
      const t = textOf(msg ? msg.content : undefined).trim()
      if (t !== '') assistants.push(t)
      continue
    }
    if (e.type === 'tool/call') {
      const d = e.data || {}
      const toolName = String(d.name || d.tool || 'tool')
      tools.set(toolName, (tools.get(toolName) || 0) + 1)
      let args = d.arguments !== undefined ? d.arguments : d.args
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = { raw: args } }
      }
      walkArgs(args, paths, 0)
      continue
    }
    if (e.type === 'request/header') {
      const h = e.data ? e.data.header : undefined
      const c = h ? h.config : undefined
      if (c && c.provider !== undefined && c.model !== undefined) model = String(c.provider) + '/' + String(c.model)
    }
  }
  return { paths: [...paths], users, assistants, tools, model }
}

/** 读上下文压力投影：{ surfaceTokens, contextWindow } */
function readPressure(ctx, session) {
  try {
    if (!ctx.sessionProjections || typeof ctx.sessionProjections.stateOf !== 'function') return null
    const st = ctx.sessionProjections.stateOf(session, 'contextPressure')
    if (!st || typeof st !== 'object') return null
    const surfaceTokens = Number(st.surfaceTokens)
    const contextWindow = Number(st.contextWindow)
    if (!Number.isFinite(surfaceTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return null
    return { surfaceTokens, contextWindow, ratio: surfaceTokens / contextWindow }
  } catch {
    return null
  }
}

// ── 交接包正文 ────────────────────────────────────────────────────────────

function bullets(items, limit) {
  if (!items || items.length === 0) return '- （无）'
  const out = []
  const n = Math.min(items.length, limit)
  for (let i = 0; i < n; i++) out.push('- ' + items[i])
  if (items.length > n) out.push('- ...（另有 ' + (items.length - n) + ' 条未列出）')
  return out.join(NL)
}

function clip(text, max) {
  const s = String(text)
  if (s.length <= max) return s
  return s.slice(0, max) + NL + '...（已截断，原文 ' + s.length + ' 字）'
}

/**
 * 按预算从**最新往旧**填，返回 { lines, used, dropped }。
 *  - lines 保持从旧到新（跟别的段一致），每条压成一行、最多 perItem 字；
 *  - 预算不够就停手，丢掉的永远是更早的那些（保新弃旧）；
 *  - 最新一条即使自己就超预算也留下 —— 否则短会话会被预算抹成空壳。
 */
function budgetPick(items, budget, perItem) {
  const lines = []
  let used = 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const flat = String(items[i]).split(NL).join(' ').trim()
    if (flat === '') continue
    const t = flat.length > perItem ? flat.slice(0, perItem) + '…' : flat
    if (lines.length > 0 && used + t.length > budget) break
    lines.push(t)
    used += t.length
  }
  lines.reverse()
  return { lines, used, dropped: items.length - lines.length }
}

function buildHandoffText(info) {
  const cfg = info.cfg
  const m = info.material
  const L = []
  L.push('# 交接包（dsh-session-shift 自动生成）')
  L.push('')
  L.push('- 生成时间：' + new Date().toISOString())
  L.push('- 触发原因：' + info.reason)
  L.push('- 原会话：' + info.sessionId + (info.sessionTitle ? '（' + info.sessionTitle + '）' : ''))
  L.push('- 工作目录：' + toDisplayPath(info.cwd))
  L.push('- 当时模型：' + (m.model || '（未记录）'))
  if (info.pressure) L.push('- 上下文压力：' + info.pressure.surfaceTokens + ' / ' + info.pressure.contextWindow + ' tokens（' + (info.pressure.ratio * 100).toFixed(1) + '%）')
  if (typeof info.compactions === 'number') L.push('- 已被压缩：' + info.compactions + ' 次（被压掉的历史已换成摘要，原文仍在旧会话的日志里）')
  if (info.filePath) L.push('- 本文件：' + toDisplayPath(info.filePath))
  L.push('')
  L.push('## 给接手的你（重要）')
  L.push('你是被自动交接拉起的新会话，**接着上一个会话继续干活**。四条纪律：')
  L.push('1. **不要重复已完成的工作**：下面「改动过的文件」里已存在的成果，先读再改，不要推翻重做。')
  L.push('2. **按需读文件**：不要一次性把所有文件读进来，按当前任务需要逐个读。')
  L.push('3. **先对齐再动手**：如果下面的摘录不足以判断进度，先问一句，不要猜着往下做。')
  L.push('4. 下面「最近用户消息」的最后一条，就是交接时的待办。')
  L.push('')
  L.push('## 改动过的文件（共 ' + m.paths.length + ' 个）')
  L.push(bullets(m.paths.slice(-120), 120))
  L.push('')
  const toolEntries = [...m.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ' x' + v)
  L.push('## 用过的工具（次数）')
  L.push(bullets(toolEntries, 12))
  L.push('')
  // 两个「最近消息」段是唯一会随会话变长而膨胀的部分 —— 先量出固定部分（头 + 尾），余量才是它们的预算。
  // 这样 maxChars 永远不会吃掉最新的内容：塞不下时丢的是**更早**的消息（保新弃旧）。
  const head = L.slice()
  const lastAssistant = m.assistants.length > 0 ? clip(m.assistants[m.assistants.length - 1], 2000) : '（无）'
  const tail = ['## 最后一条助手消息（停在哪儿）', lastAssistant, '']
  const room = Math.max(0, cfg.maxChars - head.join(NL).length - tail.join(NL).length - 240)
  const userPick = budgetPick(m.users.slice(-cfg.recentMessages), Math.min(Math.floor(room * 0.55), cfg.recentMessages * 400), 400)
  // 最后一条助手消息已经在 tail 里了，助手窗口只放它之前的（决策与进展都在这些里面）
  const assistantPick = budgetPick(m.assistants.slice(0, Math.max(0, m.assistants.length - 1)), Math.max(0, room - userPick.used), 600)
  const pickSection = (title, pick, unit) => {
    const out = [title]
    out.push(pick.lines.length > 0 ? pick.lines.map((t, i) => '- 【' + (i + 1) + '】' + t).join(NL) : '- （无）')
    if (pick.dropped > 0) out.push('- ...（更早的 ' + pick.dropped + ' 条' + unit + '因预算未列出）')
    out.push('')
    return out
  }
  let text = head
    .concat(pickSection('## 最近用户消息（从旧到新）', userPick, '用户消息'))
    .concat(pickSection('## 最近助手消息（从旧到新，决策与进展）', assistantPick, '助手消息'))
    .concat(tail)
    .join(NL)
  if (text.length > cfg.maxChars) text = text.slice(0, cfg.maxChars) + NL + '...（交接包超过 maxChars=' + cfg.maxChars + '，已截断）'
  return text
}

// ── 建新会话 ──────────────────────────────────────────────────────────────

let createUserMessagePromise
let defineToolPromise

function pickExport(mod, key) {
  const fn = (mod && mod[key]) || (mod && mod.default && mod.default[key])
  return typeof fn === 'function' ? fn : null
}

/**
 * 取 harness 自带模块（@deepseek-ai/*）。两种安装形态都得能work：
 *  1. 普通安装（npm/pnpm 装 DSH）：@deepseek-ai/* 就在 node_modules 里，裸 import 即可。
 *  2. 打包安装（代码在 resources\app.asar 内）：裸 import 会
 *     ERR_MODULE_NOT_FOUND，必须用 createRequire 从 harness 入口解析出真实
 *     路径，再 import() 那个路径 —— Electron 的 fs 能读 asar 内的文件。
 */
export async function loadHarnessModule(specifier) {
  const errors = []
  try {
    return await import(specifier)
  } catch (error) {
    errors.push('裸 import ' + (error && error.code ? error.code : String(error && error.message)))
  }
  const bases = []
  if (process.argv[1]) bases.push(process.argv[1])
  if (process.argv[2]) bases.push(join(process.argv[2], '_'))
  bases.push(process.execPath)
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch (error) {
      errors.push(base + ' → ' + (error && error.code ? error.code : String(error && error.message)))
    }
  }
  throw new Error(specifier + ' 拿不到：' + errors.join('；'))
}

/** 交接的最后一步要它把交接包变成一条 user 消息。 */
export async function loadCreateUserMessage() {
  if (createUserMessagePromise === undefined) {
    createUserMessagePromise = (async () => {
      const fn = pickExport(await loadHarnessModule('@deepseek-ai/dsh-llm'), 'createUserMessage')
      if (!fn) throw new Error('@deepseek-ai/dsh-llm 没导出 createUserMessage')
      return fn
    })().catch((error) => {
      createUserMessagePromise = undefined
      throw error
    })
  }
  return createUserMessagePromise
}

/** 桌面端够不着 HTTP 接口，手动触发靠注册一个 agent 工具 —— 那要 defineTool。 */
export async function loadDefineTool() {
  if (defineToolPromise === undefined) {
    defineToolPromise = (async () => {
      const fn = pickExport(await loadHarnessModule('@deepseek-ai/dsh-tools'), 'defineTool')
      if (!fn) throw new Error('@deepseek-ai/dsh-tools 没导出 defineTool')
      return fn
    })().catch((error) => {
      defineToolPromise = undefined
      throw error
    })
  }
  return defineToolPromise
}

async function createSessionForHandoff(ctx, opts) {
  const needed = ['agents', 'agentPresets', 'permissionPresets', 'agentDefaultModel', 'sessionTitle', 'workspaceRegistry']
  for (const service of needed) {
    if (ctx[service] === undefined) throw new Error('本机缺 ' + service + ' 服务，建不了新会话')
  }
  const preset = await ctx.agentPresets.resolve()
  const permission = ctx.permissionPresets.defaultPreset
  if (typeof permission === 'string' && permission.trim() !== '') ctx.permissionPresets.resolve(permission)
  const workspace = await ctx.workspaceRegistry.create(opts.cwd, 'dsh-session-shift')
  const sessionId = 'session-' + randomUUID()
  let agentOptions = {}
  try {
    if (typeof ctx.agentDefaultModel.currentSelection === 'function') {
      const sel = ctx.agentDefaultModel.currentSelection()
      if (sel && typeof sel === 'object') agentOptions = Object.assign({}, sel)
    }
  } catch {}
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions,
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id) },
  })
  try {
    if (typeof workspace.attachSession === 'function') await workspace.attachSession(sessionId)
    if (typeof permission === 'string' && permission.trim() !== '') ctx.permissionPresets.set(handle.agent.session, permission)
    let title = opts.title
    try {
      ctx.sessionTitle.rename(handle.agent.session, title)
    } catch {
      title = ''
    }
    const createUserMessage = await loadCreateUserMessage()
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: opts.text }], source: { kind: 'user' } }))
    return { ok: true, sessionId, title, workspacePath: workspace.path }
  } catch (error) {
    try { if (typeof workspace.detachSession === 'function') await workspace.detachSession(sessionId) } catch {}
    try { await handle.dispose() } catch {}
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function shortStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** 标题是给人看的，用本地时间；文件名/交接包头用 UTC，跨时区排序不乱。 */
function localHhMm() {
  const d = new Date()
  return String(d.getHours()).padStart(2, '0') + '-' + String(d.getMinutes()).padStart(2, '0')
}

function sessionIdOf(session) {
  if (!session) return ''
  return String(session.id || session.sessionId || (session.header && session.header.id) || '')
}

function titleOf(session) {
  if (!session) return ''
  const t = session.title || (session.header && session.header.title)
  return typeof t === 'string' ? t : ''
}

/**
 * 读当前标题。**不要只信 session.title** —— 这个版本的标题存在会话日志的
 * session/title 事件里，session 对象上没有 title 字段，直接读得到空串
 * （否则新会话会拿到兜底标题「会话交接（接 HH-MM）」，旧会话也不会被加上 [已交接]）。
 *
 * ctx.sessionTitle.get(session) 返回的是 **snapshot 对象**，不是字符串：
 *   get(session) => foldSessionTitle(session.snapshotEvents())
 *                => { title, messageSeqs, source, eventSeq, updatedAt } | undefined
 * 所以要取 .title（字符串分支留着，万一以后改成直接返字符串也不炸）。
 */
function readTitle(ctx, session) {
  try {
    if (ctx.sessionTitle && typeof ctx.sessionTitle.get === 'function') {
      const snap = ctx.sessionTitle.get(session)
      if (typeof snap === 'string' && snap.trim() !== '') return snap
      if (snap && typeof snap.title === 'string' && snap.title.trim() !== '') return snap.title
    }
  } catch {}
  // 第二来源：标题投影（落盘缓存里就是 rows.title.val）。宿主没装 sessionTitle 插件时靠这条。
  try {
    if (ctx.sessionProjections && typeof ctx.sessionProjections.stateOf === 'function') {
      const t = ctx.sessionProjections.stateOf(session, 'title')
      if (typeof t === 'string' && t.trim() !== '') return t
    }
  } catch {}
  return titleOf(session)
}

function cwdOf(session) {
  if (!session) return ''
  const candidates = [session.cwd, session.meta && session.meta.cwd, session.header && session.header.cwd, session.workspace && session.workspace.path]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c
  }
  return ''
}

/**
 * 交接后新会话的标题：`原标题（接 N）`，N 递增，永不叠加括号。
 *
 * 旧标题里的 `（接 3）`、历史遗留的 `（接 02-15）`（时间戳式）、以及运行环境自己加的防重名后缀
 * ` (1)` 都会被吃掉，取其中**最大**编号 +1；一个编号都没有就从 1 开始。
 * 取最大而不是取最后，是为了编号只增不减（手改过标题也不会把交接代数弄回去）。
 */
function nextHandoffTitle(oldTitle, suffix) {
  let t = oldTitle ? String(oldTitle).split(suffix).join(' ') : ''
  let n = 0
  for (const m of t.matchAll(/（接\s*(\d+)\s*）|\((\d+)\)\s*$/g)) {
    const v = parseInt(m[1] !== undefined ? m[1] : m[2], 10)
    if (Number.isFinite(v) && v > n) n = v
  }
  t = t.replace(/（接[^）]*）/g, ' ').replace(/\(\d+\)\s*$/, ' ').replace(/\s+/g, ' ').trim()
  const base = t === '' ? '会话交接' : t
  return (base + '（接 ' + (n + 1) + '）').slice(0, 200)
}

/**
 * 老会话此刻有没有在跑的一轮：返回这一轮的开始时间（epoch ms），没有在跑的轮次返回 null。
 */
function runningTurnStartedAt(events) {
  let startedAt = null
  for (const e of events) {
    if (!e) continue
    if (e.type === 'turn/start') startedAt = Number(e.time) || null
    else if (e.type === 'turn/end') startedAt = null
  }
  return startedAt
}

async function runHandoff(ctx, cfg, state, request) {
  const session = request.session
  if (!session) return { ok: false, error: '没有可用会话（session 缺失）' }
  const sessionId = sessionIdOf(session)
  const cwd = request.cwd || cwdOf(session) || process.cwd()
  const oldTitle = readTitle(ctx, session)
  const pressure = readPressure(ctx, session)
  const events = readEvents(session)
  // 空事件 = 读不到会话日志。静默产出一份「全是（无）」的空壳包，比直接报错危险得多。
  if (events.length === 0) {
    return { ok: false, error: '读不到会话事件（session.snapshotEvents() 返回空），交接包会是空壳，已中止。' }
  }
  const compactions = countCompactions(events)
  const material = collectMaterial(events)
  const reason = request.reason || 'manual'
  const dryRun = request.dryRun === undefined ? cfg.dryRun === true : request.dryRun === true
  const stamp = shortStamp()
  const dir = isAbsolute(cfg.handoffDir) ? cfg.handoffDir : join(cwd, cfg.handoffDir)
  let filePath = ''
  let text = buildHandoffText({ cfg, sessionId, sessionTitle: oldTitle, cwd, reason, pressure, compactions, material, filePath: '' })
  try {
    mkdirSync(dir, { recursive: true })
    filePath = join(dir, stamp + '-' + (sessionId.slice(-8) || 'session') + '.md')
    text = buildHandoffText({ cfg, sessionId, sessionTitle: oldTitle, cwd, reason, pressure, compactions, material, filePath })
    writeFileSync(filePath, text, 'utf8')
  } catch (error) {
    return { ok: false, error: '交接包落盘失败：' + (error instanceof Error ? error.message : String(error)) }
  }
  const newTitle = nextHandoffTitle(oldTitle, cfg.renameOldSuffix)
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      filePath,
      sessionId,
      pressure,
      compactions,
      newTitle,
      textLength: text.length,
      material: { paths: material.paths, users: material.users.length, assistants: material.assistants.length, tools: material.tools.size },
      preview: text.slice(0, 600),
    }
  }
  const created = await createSessionForHandoff(ctx, { cwd, title: newTitle, text })
  if (!created.ok) return { ok: false, error: created.error, filePath }
  try {
    if (oldTitle && oldTitle.trim() !== '' && oldTitle.indexOf(cfg.renameOldSuffix) < 0) {
      ctx.sessionTitle.rename(session, (oldTitle + cfg.renameOldSuffix).slice(0, 200))
    }
  } catch (error) {
    ctx.logger.warn('dsh-session-shift: 旧会话改名失败 ' + (error instanceof Error ? error.message : String(error)))
  }
  // 新会话的名字会被运行环境的自动起名覆盖（它会按内容重新概括一次），先记下来，等它跑起来再写回去一次。
  if (created.sessionId) state.pendingTitles.set(created.sessionId, newTitle)
  // 交接完成后把老会话**正在跑的那一轮**停掉：否则老会话接着干、新会话拿着同一份交接包也干，
  // 两边同时改同一批文件。走的正是界面上「停止」那条路径（agent.cancel({kind:'user'})）——
  // 不归档、不删会话，交接包也已经落盘，所以这一步不会丢活。
  // 刚起的一轮要放行：那多半是人刚发出消息、正在等回答，停掉等于把他的问题吞掉
  //（2026-10-17 真实发生过：消息入队 0.2 秒后触发交接，1 毫秒后这一轮被停）。拖久了的活照停。
  const turnStartedAt = runningTurnStartedAt(events)
  const turnAgeMs = turnStartedAt === null ? null : Date.now() - turnStartedAt
  const liveTurn = turnAgeMs !== null && turnAgeMs < cfg.liveGraceMs
  let stoppedOldTurn = false
  let stopSkipped = ''
  if (cfg.stopOldSession === false || typeof ctx.parallel !== 'function') {
    stopSkipped = 'disabled'
  } else if (liveTurn) {
    stopSkipped = 'live-turn'
    ctx.logger.info('dsh-session-shift: 老会话这一轮才起了 ' + Math.max(0, Math.round(turnAgeMs / 1000)) + ' 秒，跳过停止（liveGraceMs=' + cfg.liveGraceMs + '）')
  } else {
    try {
      await ctx.parallel('workspace/session-stop', { sessionId })
      stoppedOldTurn = true
    } catch (error) {
      ctx.logger.warn('dsh-session-shift: 停老会话这一轮失败（交接本身已完成，新会话不受影响）：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return { ok: true, newSessionId: created.sessionId, newTitle: created.title || newTitle, oldSessionId: sessionId, filePath, pressure, compactions, stoppedOldTurn, stopSkipped, turnAgeMs, material: { paths: material.paths.length, users: material.users.length } }
}

// ── 插件入口 ──────────────────────────────────────────────────────────────

function json(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/** 按 id 找活跃会话。 */
function findSession(ctx, sessionId) {
  try {
    const agents = ctx.agents
    if (agents && typeof agents.list === 'function') {
      for (const a of agents.list()) {
        const s = a && a.session
        if (s && sessionIdOf(s) === sessionId) return s
      }
    }
  } catch {}
  return null
}

/** 取最近一个活跃会话作为兜底。 */
function findCurrentSession(ctx) {
  try {
    const agents = ctx.agents
    if (agents && typeof agents.list === 'function') {
      const list = agents.list()
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i] && list[i].session
        if (s) return s
      }
    }
  } catch {}
  return null
}

/**
 * handoff_now 工具的定义。抽成导出函数是为了能被 selfcheck 真正跑一遍
 * （schema 转换 + execute + 输出契约），而不是只靠肉眼对。
 * runOnce(session, reason, cwd) -> 交接结果。
 */
export function handoffToolOptions(runOnce) {
  return {
    name: 'handoff_now',
    description: '把当前会话交接给一个新会话：生成一份交接包（改动过的文件、最近用户消息、停在哪儿）→ 建新会话 → 把交接包作为新会话的第一条消息发进去。旧会话只改名加「[已交接]」标记，不归档不删除。在上下文快满、或想换个干净会话继续长任务时调用。',
    parameters: {
      reason: {
        type: 'string',
        description: '交接原因，会写进交接包，例如「用户要求换会话」。',
      },
      dryRun: {
        type: 'boolean',
        description: 'true = 只生成交接包给人看，不建新会话、不改旧会话名。第一次验证或想先看交接包质量时用这个。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '是否成功（dryRun 也算成功）。' },
          dryRun: { type: 'boolean', required: true, description: '是否为只生成不建会话的试跑。' },
          newSessionId: { type: 'string', required: true, description: '新会话 id；试跑或失败时为空字符串。' },
          newTitle: { type: 'string', required: true, description: '新会话标题（试跑时是「预计标题」）。' },
          filePath: { type: 'string', required: true, description: '交接包落盘的绝对路径。' },
          error: { type: 'string', required: true, description: '失败原因；成功时为空字符串。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: !value.ok
          ? '交接失败：' + value.error
          : value.dryRun
            ? '试跑：交接包已生成 ' + value.filePath + '（没建新会话、没改名），预计新会话标题「' + value.newTitle + '」。确认没问题后去掉 dryRun 再调一次。'
            : '已交接 → 新会话「' + value.newTitle + '」(' + value.newSessionId + ')，交接包：' + value.filePath + '。需要手动在会话列表里点过去。',
      }],
    },
    execute: async (args, exec) => {
      const session = exec && exec.agent ? exec.agent.session : null
      const result = await runOnce(session, (args && args.reason) || 'manual（工具触发）', exec && exec.cwd, args && args.dryRun)
      return {
        ok: result.ok === true,
        dryRun: result.dryRun === true,
        newSessionId: result.ok && !result.dryRun ? String(result.newSessionId || '') : '',
        newTitle: result.ok ? String(result.newTitle || '') : '',
        filePath: String(result.filePath || ''),
        error: result.ok ? '' : String(result.error || '未知错误'),
      }
    },
  }
}

export async function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const state = { lastRunBySession: new Map(), busy: new Set(), doneBySession: new Set(), doneSkips: 0, pendingTitles: new Map(), lastResult: null, runs: 0, autoRuns: 0, skipped: 0, compactionScan: new Map(), lastCompaction: null, warnedCompaction: '', lastClient: null, clientLog: [], tool: 'pending', toolError: '' }

  function runOnce(session, reason, cwd, dryRun) {
    return runHandoff(ctx, cfg, state, { session, reason, cwd, dryRun }).then((result) => {
      state.runs += 1
      state.lastResult = result
      return result
    })
  }

  ctx.connection.fetch.register({
    path: '/api/handoff/run',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = {}
      try { body = await request.json() } catch {}
      const session = body && body.sessionId ? findSession(ctx, body.sessionId) : findCurrentSession(ctx)
      const result = await runOnce(session, (body && body.reason) || 'manual', body && body.cwd, body && body.dryRun)
      return json(result.ok ? 200 : 500, result)
    },
  })

  ctx.connection.fetch.register({
    path: '/api/handoff/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(200, {
      ok: true,
      config: cfg,
      runs: state.runs,
      autoRuns: state.autoRuns,
      skipped: state.skipped,
      busy: [...state.busy],
      // 已经自动交接过、不再重复触发的会话（每个会话只自动交接一次）+ 因此被拦下的次数。
      doneSessions: [...state.doneBySession],
      doneSkips: state.doneSkips,
      lastResult: state.lastResult,
      // 压缩事件改名会让「已压缩 N 次」静默失效 —— 放在这里，一个 curl 就能看见。
      compaction: state.lastCompaction,
      warning: state.lastCompaction ? state.lastCompaction.warning : '',
      // 工具注册失败过去只有一行 warn，谁都看不见 —— 放在这里，一个 curl 就能验。
      tool: state.tool,
      toolError: state.toolError,
      // 客户端那半边回报的实际情况（切会话方法名 / sessions 的 API 清单）。
      client: state.lastClient,
    }),
  })

  // 客户端（浏览器那半边）把「实际命中的切会话方法名 + sessions API 清单」回报到这里。
  // 这个 harness 版本没有公开的客户端接口文档，靠猜不如让它在真实环境里自己报一次。
  ctx.connection.fetch.register({
    path: '/api/handoff/client',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = {}
      try { body = await request.json() } catch {}
      const clean = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max)
      state.lastClient = {
        at: new Date().toISOString(),
        build: clean(body.build, 40),
        event: clean(body.event, 40),
        method: clean(body.method, 40),
        sessionId: clean(body.sessionId, 80),
        error: clean(body.error, 300),
        api: Array.isArray(body.api) ? body.api.slice(0, 80).map((name) => clean(name, 60)) : [],
        // 侦察负载（服务清单等）原样留一份，省得每问一个问题就改一次字段。
        raw: (() => { try { return JSON.stringify(body).slice(0, 8000) } catch { return '' } })(),
      }
      ctx.logger.info('dsh-session-shift: 客户端回报 ' + state.lastClient.event
        + (state.lastClient.method ? '（sessions.' + state.lastClient.method + '）' : ''))
      try {
        const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')
        mkdirSync(home, { recursive: true })
        state.clientLog = state.clientLog.concat([state.lastClient]).slice(-20)
        writeFileSync(join(home, 'handoff-client-report.json'), JSON.stringify({ reports: state.clientLog }, null, 2), 'utf8')
      } catch {}
      return json(200, { ok: true })
    },
  })

  // 桌面端拿不到 web token，HTTP 接口够不着 —— 手动触发走这个工具。
  try {
    const defineTool = await loadDefineTool()
    ctx.tools.register(defineTool(handoffToolOptions((session, reason, cwd, dryRun) => runOnce(session, reason, cwd, dryRun))))
    state.tool = 'registered'
    ctx.logger.info('dsh-session-shift: 手动触发工具 handoff_now 已注册')
  } catch (error) {
    state.tool = 'failed'
    state.toolError = error instanceof Error ? error.message : String(error)
    ctx.logger.warn('dsh-session-shift: handoff_now 工具注册失败（HTTP 接口与自动交接不受影响）：' + state.toolError)
  }

  // 新会话第一轮结束时再写一次标题（运行环境的自动起名通常在这一轮里覆盖过它），然后就不再碰它的标题
  // —— 之后你自己改的名字不会被插件抢回去。注册在 enabled 判断之前：手动 handoff_now 关着自动交接时也能用。
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    try {
      const session = agent && agent.session
      if (!session) return
      const sid = sessionIdOf(session)
      const pending = state.pendingTitles.get(sid)
      if (!pending) return
      state.pendingTitles.delete(sid)
      if (readTitle(ctx, session).indexOf(pending) < 0) ctx.sessionTitle.rename(session, pending)
    } catch (error) {
      ctx.logger.warn('dsh-session-shift: 写回新会话标题失败 ' + (error instanceof Error ? error.message : String(error)))
    }
  })

  if (!cfg.enabled) {
    ctx.logger.info('dsh-session-shift: enabled=false，只挂接口不做自动交接')
    return
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      const session = agent && agent.session
      if (session && !signal.aborted) {
        const sid = sessionIdOf(session)
        const pressure = readPressure(ctx, session)
        // 两个条件取或：压力到阈值，或者这个会话已经被 compaction 压过 N 次。
        // 只有压力一个条件时，compaction 会把压力压回它自己的阈值以下，自动交接永远等不到触发点。
        const byPressure = pressure !== null && pressure.ratio >= cfg.thresholdRatio
        const scan = cfg.maxCompactions > 0 ? compactionsSince(session, sid, state) : { count: 0, starts: 0 }
        const compactions = scan.count
        const byCompaction = cfg.maxCompactions > 0 && compactions >= cfg.maxCompactions
        const due = byPressure || byCompaction
        const warning = compactionWarning(scan)
        state.lastCompaction = { sessionId: sid, summaries: compactions, starts: scan.starts, warning }
        if (warning !== '' && state.warnedCompaction !== warning) {
          state.warnedCompaction = warning
          ctx.logger.warn('dsh-session-shift: ' + warning)
        }
        const last = state.lastRunBySession.get(sid) || 0
        const cooled = Date.now() - last >= cfg.cooldownMs
        // 每个会话只自动交接一次。
        // 交接不会清空老会话的上下文，所以 due 一旦为真就永远为真（「已压缩 ≥ N 次」只会越数越多），
        // 只靠 cooldown 拦 = 每 5 分钟重复交接一次，每次新开一个会话，于是几个会话同时干同一件事。
        // 终态取两个来源：内存（本次运行内已交接）+ 标题里的 [已交接]（交接时自己加的，DSH 重启后仍然有效）。
        const title = readTitle(ctx, session)
        const alreadyDone = state.doneBySession.has(sid) || (title !== '' && title.indexOf(cfg.renameOldSuffix) >= 0)
        // 新会话的名字会被运行环境的自动起名（按内容概括）覆盖，记着的那份在这里先写回一次。
        const pending = state.pendingTitles.get(sid)
        if (pending && title.indexOf(pending) < 0) {
          try { ctx.sessionTitle.rename(session, pending) } catch {}
        }
        if (due && !alreadyDone && cooled && !state.busy.has(sid)) {
          state.busy.add(sid)
          state.lastRunBySession.set(sid, Date.now())
          state.autoRuns += 1
          const reason = byPressure
            ? 'auto: 压力 ' + (pressure.ratio * 100).toFixed(1) + '% >= ' + (cfg.thresholdRatio * 100).toFixed(0) + '%'
            : 'auto: 本会话已被压缩 ' + compactions + ' 次 >= ' + cfg.maxCompactions + ' 次'
          ctx.logger.info('dsh-session-shift: 触发自动交接（' + reason + '）')
          runHandoff(ctx, cfg, state, { session, reason })
            .then((r) => {
              state.lastResult = r
              if (r.ok && r.dryRun) ctx.logger.info('dsh-session-shift: [dryRun] 交接包已生成 ' + r.filePath)
              else if (r.ok) {
                // 交接成功才落终态；失败（例如读不到会话事件）要留着下次再试。
                state.doneBySession.add(sid)
                ctx.logger.info('dsh-session-shift: 新会话 ' + r.newSessionId + ' 标题「' + r.newTitle + '」，交接包 ' + r.filePath + '（本会话不再自动交接）')
              } else ctx.logger.warn('dsh-session-shift: 交接失败 ' + r.error)
            })
            .catch((error) => ctx.logger.warn('dsh-session-shift: 交接异常 ' + (error instanceof Error ? error.message : String(error))))
            .finally(() => state.busy.delete(sid))
        } else if (due) {
          if (alreadyDone) state.doneSkips += 1
          state.skipped += 1
        }
      }
    } catch (error) {
      ctx.logger.warn('dsh-session-shift: pre-step 检查失败 ' + (error instanceof Error ? error.message : String(error)))
    }
    return next()
  })

  const triggerText = '压力 ' + (cfg.thresholdRatio * 100).toFixed(0) + '%' + (cfg.maxCompactions > 0 ? ' 或已压缩 ' + cfg.maxCompactions + ' 次' : '')
  ctx.logger.info('dsh-session-shift: 已启用（' + triggerText + '，冷却 ' + Math.round(cfg.cooldownMs / 1000) + 's，dryRun=' + cfg.dryRun + '）')
  ctx.logger.info('dsh-session-shift: 手动触发 POST /api/handoff/run，状态 GET /api/handoff/status')
}
