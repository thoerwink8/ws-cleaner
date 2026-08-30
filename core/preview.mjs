/**
 * 工作区清理器 · 会话预览（只读粗览）。
 *
 * 约定（设计树 Q10/Q11）：
 *  - 只解析 pi / claude / codex；orca 不支持预览
 *  - 纯文本抽取：不渲染 markdown/HTML，不执行任何代码
 *  - 每条消息截断到 MAX_TEXT 字符，消息上限 MAX_MESSAGES
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const MAX_MESSAGES = 400;
const MAX_TEXT = 2000;

function truncate(s, n = MAX_TEXT) {
  if (s == null) return '';
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 从多种 content 形态里抽纯文本：string | array[{text|type:'text'}] | {text} */
function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (!c || typeof c !== 'object') return '';
      if (typeof c.text === 'string') return c.text;
      if (c.type === 'tool_use') return `[工具调用] ${c.name || ''}${c.input ? ' ' + truncate(JSON.stringify(c.input), 200) : ''}`;
      if (c.type === 'thinking') return `[思考] ${truncate(c.thinking ?? c.text ?? '', 300)}`;
      if (c.type === 'tool_result') return `[工具结果] ${truncate(c.content ?? '', 300)}`;
      if (c.type === 'input_text' || c.type === 'output_text') return c.text || '';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.thinking === 'string') return `[思考] ${content.thinking}`;
    return truncate(JSON.stringify(content), 300);
  }
  return '';
}

/** pi 会话记录：type=session 首行带 cwd；message 记录结构 { type:'message', message:{ role, content:[...] } } */
function parsePi(lines, meta) {
  const messages = [];
  let startAt = null, endAt = null;
  for (const rec of lines) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'message') {
      const inner = rec.message ?? {};
      const role = inner.role === 'user' ? 'user' : inner.role === 'tool' ? 'tool' : 'assistant';
      const text = extractText(inner.content);
      if (!text) continue;
      messages.push({ role, ts: rec.timestamp ?? null, text: truncate(text) });
      if (endAt == null || (rec.timestamp && rec.timestamp > endAt)) endAt = rec.timestamp ?? endAt;
    } else if (rec.type === 'session') {
      meta.cwd = rec.cwd ?? meta.cwd;
      if (rec.timestamp && startAt == null) startAt = rec.timestamp;
    }
  }
  return { messages, startAt, endAt };
}

/** claude 会话记录：type=user/assistant，message.content 数组 */
function parseClaude(lines, meta) {
  const messages = [];
  let startAt = null, endAt = null;
  for (const rec of lines) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'user' || rec.type === 'assistant') {
      const role = rec.type === 'user' ? 'user' : 'assistant';
      const content = rec.message?.content ?? rec.message?.text ?? rec.content;
      const text = extractText(content);
      if (!text) continue;
      messages.push({ role, ts: rec.timestamp ?? null, text: truncate(text) });
      if (endAt == null || (rec.timestamp && rec.timestamp > endAt)) endAt = rec.timestamp ?? endAt;
    }
    if (rec.timestamp && startAt == null) startAt = rec.timestamp;
  }
  return { messages, startAt, endAt };
}

/** codex 会话记录：response_item.payload 即消息体（payload.type='message'，含 role/content） */
function parseCodex(lines, meta) {
  const messages = [];
  let startAt = null, endAt = null;
  for (const rec of lines) {
    if (!rec || typeof rec !== 'object') continue;
    const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
    const msg = payload?.type === 'message' ? payload : (rec.message ?? null);
    const role = msg?.role ?? (rec.type === 'user_message' ? 'user' : null);
    if (!msg || !role) continue;
    const text = extractText(msg.content);
    if (!text) continue;
    messages.push({ role, ts: rec.timestamp ?? null, text: truncate(text) });
    if (endAt == null || (rec.timestamp && rec.timestamp > endAt)) endAt = rec.timestamp ?? endAt;
    if (rec.timestamp && startAt == null) startAt = rec.timestamp;
    if (payload?.cwd) meta.cwd = payload.cwd;
    if (rec.cwd) meta.cwd = rec.cwd;
  }
  return { messages, startAt, endAt };
}

/**
 * 预览一个会话文件。
 * @param {string} path 会话 jsonl 路径
 * @param {string} agent pi | claude | codex
 */
export async function previewSession(path, agent) {
  const buf = await readFile(path, { encoding: 'utf8' });
  const lines = buf.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const meta = { cwd: null };
  let parsed;
  if (agent === 'pi') parsed = parsePi(lines, meta);
  else if (agent === 'claude') parsed = parseClaude(lines, meta);
  else if (agent === 'codex') parsed = parseCodex(lines, meta);
  else return { previewable: false, message: '此会话类型暂不支持预览' };

  const messages = parsed.messages.slice(-MAX_MESSAGES);
  const turnCount = parsed.messages.filter((m) => m.role === 'user').length;
  return {
    previewable: true,
    agent,
    path,
    name: basename(path),
    cwd: meta.cwd,
    messageCount: parsed.messages.length,
    turnCount,
    startAt: parsed.startAt,
    endAt: parsed.endAt,
    // 面板展示：最近的消息在上
    messages: [...messages].reverse(),
  };
}

/**
 * 轻量摘要：扫描列表用。抽轮次 + 最近一条用户消息作预览片段。
 * orca 不解析。
 */
export async function peekSessionSummary(path, agent) {
  if (agent === 'orca') return { turnCount: null, snippet: null, messageCount: null };
  try {
    const buf = await readFile(path, { encoding: 'utf8' });
    // 超大文件只看尾部，足够拿最近摘要；轮次用全文粗计
    const MAX_PEEK = 512 * 1024;
    const head = buf.length > MAX_PEEK * 2 ? buf.slice(0, 64 * 1024) : buf;
    const tail = buf.length > MAX_PEEK ? buf.slice(-MAX_PEEK) : buf;
    const parseChunk = (text) => text.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    const meta = { cwd: null };
    let parsed;
    if (agent === 'pi') parsed = parsePi(parseChunk(tail), meta);
    else if (agent === 'claude') parsed = parseClaude(parseChunk(tail), meta);
    else if (agent === 'codex') parsed = parseCodex(parseChunk(tail), meta);
    else return { turnCount: null, snippet: null, messageCount: null };

    // 轮次：优先用全文粗匹配，避免大文件全量 JSON.parse
    let turnCount = 0;
    if (agent === 'pi') {
      turnCount = (buf.match(/"role"\s*:\s*"user"/g) || []).length;
    } else if (agent === 'claude') {
      turnCount = (buf.match(/"type"\s*:\s*"user"/g) || []).length;
    } else if (agent === 'codex') {
      turnCount = (buf.match(/"role"\s*:\s*"user"/g) || []).length;
    }
    if (!turnCount) turnCount = parsed.messages.filter((m) => m.role === 'user').length;

    const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')
      || [...parsed.messages].reverse().find((m) => m.role === 'assistant');
    const snippet = lastUser
      ? truncate(String(lastUser.text).replace(/\s+/g, ' ').trim(), 120)
      : '';

    // cwd 偶尔只在文件头：尾部解析不到时再看一眼头部
    if (!meta.cwd && head !== tail) {
      if (agent === 'pi') parsePi(parseChunk(head), meta);
      else if (agent === 'codex') parseCodex(parseChunk(head), meta);
    }

    return {
      turnCount,
      snippet: snippet || null,
      messageCount: turnCount ? turnCount * 2 : parsed.messages.length, // 粗估，列表主要用 turnCount
      cwd: meta.cwd || null,
    };
  } catch {
    return { turnCount: null, snippet: null, messageCount: null };
  }
}
