/**
 * 窗口尺寸（dsh-window-size）——宿主半。
 *
 * 一件事：把客户端主窗口的宽高/位置存进 `~/.dsh/window-size.json`，并在客户端每次启动时
 * 自动恢复一次。入口只长在「设置」里（`lib/client.js` 注册的 `settings.section`），
 * 主界面不加任何按钮/面板，也不注册工具。
 *
 * 和"窗口守护脚本"的区别（用户明确要求）：
 *  - 没有计划任务、没有常驻轮询、没有外部 PowerShell 进程，因此不存在"客户端没开也每几分钟弹一下"；
 *  - 窗口操作在本进程内用 Win32（koffi → user32）完成，不产生任何可见窗口；
 *  - 只在两种时刻动手：客户端启动后收敛一次、用户在设置页点保存。
 *
 * 通信走宿主的 connection.fetch 通道（和 dsh-novel-desk 同一套）：
 * 客户端 `ctx.connection.rpc.call('/api', 'window-size/dispatch', {action, args})`
 * → 这里回 `{type:'server-response', rpcId, result:{ok, value|error}}`。
 */

import {
  appendLog,
  clearConfig,
  configPath,
  readConfig,
  resolveHome,
  writeConfig,
} from './store.js';
import * as win from './win32.js';

export const name = 'window-size';

/** RPC 端点与路径：客户端与宿主两侧必须一致。 */
const ENDPOINT = 'window-size/dispatch';
const PATH = `/api/${ENDPOINT}`;

/** 宽高的下限就是客户端 BrowserWindow 自己的 minWidth / minHeight。 */
const MIN_WIDTH = 520;
const MIN_HEIGHT = 600;
const MAX_WIDTH = 10000;
const MAX_HEIGHT = 10000;
const MAX_POSITION = 20000;

/** 启动等待窗口出现的上限：60 秒，每 500ms 看一次；窗口一出现就应用，然后彻底停手。 */
const STARTUP_TICKS = 120;
const STARTUP_INTERVAL_MS = 500;
/** 窗口刚出现时客户端还会自己摆一次位置，等它摆完再动手。 */
const SETTLE_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (body) => Response.json(body, { headers: { 'cache-control': 'no-store' } });
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const invalid = (message) => Object.assign(new Error(message), { code: 'WINDOW_SIZE_INVALID' });

/* ------------------------------------------------------------------ *
 * 校验与文案
 * ------------------------------------------------------------------ */

function numberField(value, label, min, max, required) {
  if (value === null || value === undefined || value === '') {
    if (required) throw invalid(`${label}不能为空`);
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw invalid(`${label}必须是数字`);
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) throw invalid(`${label}要在 ${min}–${max} 之间`);
  return rounded;
}

/** 把客户端送来的草稿变成一份可以落盘的配置；不合格就抛（不会写出半截文件）。 */
function validateGeometry(args = {}) {
  const geometry = {
    width: numberField(args.width, '宽', MIN_WIDTH, MAX_WIDTH, true),
    height: numberField(args.height, '高', MIN_HEIGHT, MAX_HEIGHT, true),
    x: numberField(args.x, 'X', -MAX_POSITION, MAX_POSITION, false),
    y: numberField(args.y, 'Y', -MAX_POSITION, MAX_POSITION, false),
    maximized: args.maximized === true,
    applyOnStart: args.applyOnStart !== false,
    savedAt: new Date().toISOString(),
  };
  return geometry;
}

export function geometryText(geometry) {
  if (!geometry) return '(空)';
  if (geometry.maximized === true) return `最大化（记录 ${geometry.width}×${geometry.height}）`;
  const at = Number.isFinite(geometry.x) && Number.isFinite(geometry.y) ? ` @ (${geometry.x}, ${geometry.y})` : '';
  return `${geometry.width}×${geometry.height}${at}`;
}

export function appliedText(applied) {
  if (!applied) return '(无结果)';
  if (!applied.ok) return `失败 ${applied.code}${applied.error ? `：${applied.error}` : ''}`;
  const after = applied.after;
  const where = after ? `${after.width}×${after.height} @ (${after.x}, ${after.y})` : '尺寸未知';
  return `成功（第 ${applied.attempts ?? 1} 次尝试，${where}）`;
}

/* ------------------------------------------------------------------ *
 * 状态与派发
 * ------------------------------------------------------------------ */

function stateOf(config, titleMatch) {
  const read = readConfig(config);
  return {
    saved: read.config,
    savedError: read.error ?? null,
    configFile: read.file,
    home: resolveHome(config),
    current: win.readWindow(titleMatch),
    screen: win.screenSize(),
    ffi: win.diagnose(),
  };
}

async function dispatch(config, titleMatch, payload) {
  const action = typeof payload?.action === 'string' ? payload.action.trim() : '';
  const args = payload?.args ?? {};

  switch (action) {
    case 'state.get':
      return { ...stateOf(config, titleMatch) };

    case 'config.save': {
      const geometry = validateGeometry(args);
      writeConfig(config, geometry);
      const applied = await win.applyWithRetry(geometry, { titleMatch });
      appendLog(config, `save ${geometryText(geometry)} → ${appliedText(applied)}`);
      return { ...stateOf(config, titleMatch), applied };
    }

    case 'config.apply': {
      const read = readConfig(config);
      if (!read.config) throw invalid(read.error ? `保存的配置读不出来：${read.error}` : '还没有保存过尺寸');
      const applied = await win.applyWithRetry(read.config, { titleMatch });
      appendLog(config, `apply ${geometryText(read.config)} → ${appliedText(applied)}`);
      return { ...stateOf(config, titleMatch), applied };
    }

    case 'config.clear': {
      const cleared = clearConfig(config);
      if (!cleared.cleared) throw invalid(`删除失败：${cleared.error}`);
      appendLog(config, 'clear（回到客户端默认尺寸）');
      return { ...stateOf(config, titleMatch), cleared: true };
    }

    case 'window.read':
      return { ...stateOf(config, titleMatch), fill: win.readWindow(titleMatch) };

    case 'windows.list':
      return {
        ...stateOf(config, titleMatch),
        windows: win.listWindows()
          .filter((item) => item.visible)
          .map(({ handle, ...rest }) => rest),
      };

    default:
      throw invalid(`未知操作 ${action || '(empty)'}`);
  }
}

/* ------------------------------------------------------------------ *
 * 注册：RPC 路由 + 启动应用
 * ------------------------------------------------------------------ */

function registerRpc(ctx, config, { logger, titleMatch }) {
  const route = async (request) => {
    let message;
    try {
      message = await request.json();
    } catch {
      return json({ type: 'server-response', rpcId: 'invalid-request', result: failure('WINDOW_SIZE_BAD_JSON', '请求体不是 JSON') });
    }
    const rpcId = typeof message?.rpcId === 'string' && message.rpcId ? message.rpcId : 'invalid-request';
    if (message?.type !== 'client-request' || message?.method !== ENDPOINT) {
      return json({ type: 'server-response', rpcId, result: failure('WINDOW_SIZE_BAD_REQUEST', '不是有效的窗口尺寸请求') });
    }
    try {
      const value = await dispatch(config, titleMatch, message.payload ?? {});
      return json({ type: 'server-response', rpcId, result: { ok: true, value } });
    } catch (error) {
      const code = error?.code ?? 'WINDOW_SIZE_ERROR';
      return json({ type: 'server-response', rpcId, result: failure(code, error?.message ?? String(error)) });
    }
  };

  const mount = (scope) => {
    const connection = scope.get?.('connection') ?? scope.connection;
    if (typeof connection?.fetch?.register !== 'function') {
      logger?.warn?.('window-size: 客户端没有 connection.fetch，设置页拿不到数据（其它功能不受影响）');
      return;
    }
    scope.effect(() => connection.fetch.register({
      path: PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route,
    }), 'window-size: rpc route');
  };

  if (typeof ctx.inject === 'function') ctx.inject(['connection'], mount);
  else mount(ctx);
}

/** 客户端启动后：等主窗口出现 → 等它摆稳 → 应用一次保存过的尺寸 → 收工。 */
function scheduleStartupApply(ctx, config, { logger, titleMatch }) {
  const read = readConfig(config);
  if (!read.config) return;
  if (read.config.applyOnStart === false) return;
  const saved = read.config;

  const run = async (alive) => {
    for (let tick = 0; tick < STARTUP_TICKS; tick += 1) {
      await sleep(STARTUP_INTERVAL_MS);
      if (!alive()) return;
      if (!win.readWindow(titleMatch)) continue;
      await sleep(SETTLE_MS);
      if (!alive()) return;
      const applied = await win.applyWithRetry(saved, { titleMatch });
      const line = `startup ${geometryText(saved)} → ${appliedText(applied)}`;
      appendLog(config, line);
      logger?.info?.(`window-size: ${line}`);
      return;
    }
    appendLog(config, 'startup: 超时没等到客户端主窗口，跳过这次（下次启动再试）');
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      let alive = true;
      void run(() => alive);
      return () => {
        alive = false;
      };
    }, 'window-size: startup apply');
    return;
  }
  void run(() => true);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? {};
  const titleMatch = typeof config.titleMatch === 'string' && config.titleMatch.trim()
    ? config.titleMatch.trim()
    : win.DEFAULT_TITLE_MATCH;

  try {
    registerRpc(ctx, config, { logger, titleMatch });
  } catch (error) {
    logger?.warn?.(`window-size: 注册设置页路由失败 ${error?.message ?? error}`);
  }

  try {
    scheduleStartupApply(ctx, config, { logger, titleMatch });
  } catch (error) {
    logger?.warn?.(`window-size: 启动应用安排失败 ${error?.message ?? error}`);
  }

  logger?.info?.(`window-size: 配置文件 ${configPath(config)}`);
}