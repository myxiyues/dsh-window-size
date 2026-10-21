/**
 * Win32 窗口层：只做四件事——找出客户端主窗口、读它的位置尺寸、改它的位置尺寸、报错说人话。
 *
 * 绑定走 koffi（客户端自带，在 `resources\app.asar.unpacked\dsh\node_modules\koffi`），
 * 本进程内直接调 user32.dll：
 *  - 不起任何外部进程、不开控制台窗口、不写计划任务——这是它和"窗口守护脚本"的根本区别；
 *  - 本进程是客户端主进程的子进程，完整性级别一致，SetWindowPos 不会被 UIPI 拦；
 *  - 懒加载：只有真要动窗口时才 load DLL，加载失败也只回报原因，绝不抛给宿主。
 *
 * 安全边界：只认"标题匹配 + 本进程树"的窗口（见 pickTarget），永不碰别的程序，
 * 也永不通过枚举顺序误伤不确定的窗口。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** koffi 类型名带 v1 后缀且全局唯一：koffi 的类型表是进程级的，重名会抛。 */
const RECT_TYPE = 'dsh_window_size_rect_v1';
const ENUM_PROC_TYPE = 'dsh_window_size_enum_proc_v1';

const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
/** NOACTIVATE | NOZORDER | SHOWWINDOW | ASYNCWINDOWPOS（沿用已验证过的组合）。 */
const SWP_FLAGS = 0x0454;
/** GetSystemMetrics 索引：0=宽 1=高。 */
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

/** 默认标题匹配（客户端主窗口标题里一定带这段）。 */
export const DEFAULT_TITLE_MATCH = 'DeepSeek Harness';

let cache = null;

/** koffi 的候选位置：客户端自带的那一份优先。 */
function koffiCandidates() {
  const candidates = [];
  const execDir = typeof process.execPath === 'string' && process.execPath ? path.dirname(process.execPath) : '';
  if (execDir) {
    candidates.push(path.join(execDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
    candidates.push(path.join(execDir, 'resources', 'app.asar', 'dsh', 'node_modules', 'koffi'));
  }
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resources) candidates.push(path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
  candidates.push('koffi');
  return candidates;
}

function requireKoffi() {
  const require = createRequire(import.meta.url);
  let lastError = null;
  for (const candidate of koffiCandidates()) {
    if (candidate !== 'koffi' && !existsSync(candidate)) continue;
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('找不到 koffi（客户端自带的那份也没找到）');
}

/** 注册类型：已经注册过（同名同布局）就直接复用，不重复注册。 */
function defineTypes(koffi) {
  try {
    koffi.struct(RECT_TYPE, { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  } catch {
    /* 已注册：布局相同，直接引用名字即可 */
  }
  try {
    koffi.proto(`bool ${ENUM_PROC_TYPE}(void *hwnd, void *lparam)`);
  } catch {
    /* 同上 */
  }
}

function bindApis(koffi) {
  defineTypes(koffi);
  const user32 = koffi.load('user32.dll');
  return {
    EnumWindows: user32.func(`bool __stdcall EnumWindows(${ENUM_PROC_TYPE} *cb, void *lparam)`),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
    IsZoomed: user32.func('bool __stdcall IsZoomed(void *hwnd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, void *buf, int max)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
    GetWindowRect: user32.func(`bool __stdcall GetWindowRect(void *hwnd, _Out_ ${RECT_TYPE} *rect)`),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32 flags)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
  };
}

/** 加载一次，之后复用。永不抛。 */
export function load() {
  if (cache !== null) return cache;
  const record = { ok: false, error: null, api: null, version: null, source: null };
  cache = record;
  try {
    let resolved = null;
    for (const candidate of koffiCandidates()) {
      if (candidate !== 'koffi' && !existsSync(candidate)) continue;
      resolved = candidate;
      break;
    }
    const koffi = requireKoffi();
    record.api = bindApis(koffi);
    record.version = typeof koffi.version === 'string' ? koffi.version : null;
    record.source = resolved;
    record.ok = true;
  } catch (error) {
    record.error = error?.message ?? String(error);
  }
  return record;
}

/** 诊断信息（设置页会显示这个，出问题时一眼看出卡在哪）。 */
export function diagnose() {
  const { ok, error, version, source } = load();
  return { ok, error, koffi: version, source, platform: process.platform, parentPid: process.ppid };
}

export function screenSize() {
  const { ok, api } = load();
  if (!ok) return null;
  try {
    return { width: api.GetSystemMetrics(SM_CXSCREEN), height: api.GetSystemMetrics(SM_CYSCREEN) };
  } catch {
    return null;
  }
}

/** 枚举所有顶层窗口（只读）。 */
export function listWindows() {
  const { ok, api } = load();
  if (!ok) return [];
  const windows = [];
  try {
    api.EnumWindows((hwnd, _lparam) => {
      const pidRef = [0];
      api.GetWindowThreadProcessId(hwnd, pidRef);
      const buffer = Buffer.alloc(1024);
      api.GetWindowTextW(hwnd, buffer, 512);
      const title = buffer.toString('ucs2').replace(/\u0000+$/, '');
      const rect = {};
      const hasRect = api.GetWindowRect(hwnd, rect) === true;
      windows.push({
        handle: hwnd,
        hwnd: String(hwnd),
        pid: pidRef[0],
        title,
        visible: api.IsWindowVisible(hwnd) === true,
        minimized: api.IsIconic(hwnd) === true,
        maximized: api.IsZoomed(hwnd) === true,
        rect: hasRect
          ? { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
          : null,
      });
      return true;
    }, null);
  } catch {
    return [];
  }
  return windows;
}

function areaOf(window) {
  if (!window.rect) return 0;
  return Math.max(0, window.rect.width) * Math.max(0, window.rect.height);
}

/**
 * 挑客户端主窗口：先按标题匹配，其次按"本进程树"匹配，绝不选其它程序的窗口。
 * 返回 { window, reason } 或 null。
 */
export function pickTarget(windows, titleMatch = DEFAULT_TITLE_MATCH, parentPid = process.ppid) {
  const candidates = windows.filter((item) => item.visible && item.rect !== null);
  const byPattern = candidates.filter((item) => item.title && item.title.includes(titleMatch));
  const sameProcess = candidates.filter((item) => item.pid === parentPid);
  const biggest = (list) => list.slice().sort((a, b) => areaOf(b) - areaOf(a))[0] ?? null;

  const ownTitle = biggest(byPattern.filter((item) => item.pid === parentPid));
  if (ownTitle) return { window: ownTitle, reason: 'title+process' };
  const byTitle = biggest(byPattern);
  if (byTitle) return { window: byTitle, reason: 'title' };
  const own = biggest(sameProcess);
  if (own) return { window: own, reason: 'process' };
  return null;
}

/** 读客户端主窗口的当前状态（只读，不动它）。 */
export function readWindow(titleMatch = DEFAULT_TITLE_MATCH) {
  const { ok, error } = load();
  if (!ok) return null;
  const picked = pickTarget(listWindows(), titleMatch);
  if (!picked) return null;
  const { window: target, reason } = picked;
  return {
    title: target.title,
    pid: target.pid,
    hwnd: target.hwnd,
    rect: target.rect,
    minimized: target.minimized,
    maximized: target.maximized,
    matched: reason,
  };
}

/**
 * 应用一份几何配置（同步一次尝试）。
 * @returns {{ok:boolean, code?:string, error?:string, before?:object, after?:object, target?:object}}
 */
export function applyGeometry(geometry, titleMatch = DEFAULT_TITLE_MATCH) {
  const { ok, error, api } = load();
  if (!ok) return { ok: false, code: 'ffi-unavailable', error };
  if (!geometry) return { ok: false, code: 'no-config' };

  const picked = pickTarget(listWindows(), titleMatch);
  if (!picked) return { ok: false, code: 'window-not-found' };
  const { window: target, reason } = picked;
  const before = target.rect;

  try {
    if (geometry.maximized === true) {
      if (!target.maximized) api.ShowWindow(target.handle, SW_MAXIMIZE);
    } else {
      if (target.maximized || target.minimized) api.ShowWindow(target.handle, SW_RESTORE);
      const x = Number.isFinite(geometry.x) ? geometry.x : (before?.x ?? 0);
      const y = Number.isFinite(geometry.y) ? geometry.y : (before?.y ?? 0);
      api.SetWindowPos(target.handle, null, x, y, geometry.width, geometry.height, SWP_FLAGS);
    }
  } catch (failure) {
    return { ok: false, code: 'ffi-call-failed', error: failure?.message ?? String(failure), before };
  }

  const after = readWindow(titleMatch);
  return {
    ok: true,
    before,
    target: { title: target.title, hwnd: target.hwnd, matched: reason },
    after: after ? { ...after.rect, maximized: after.maximized, minimized: after.minimized } : null,
  };
}

/** 上一次尝试是否已经达到目标（宽高必对；给了 x/y 才校验位置；最大化只看状态）。 */
export function matches(geometry, after) {
  if (!after) return false;
  if (geometry.maximized === true) return after.maximized === true;
  if (after.width !== geometry.width || after.height !== geometry.height) return false;
  if (Number.isFinite(geometry.x) && after.x !== geometry.x) return false;
  if (Number.isFinite(geometry.y) && after.y !== geometry.y) return false;
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 应用并核验：窗口刚显示时客户端还会自己摆一次位置，所以最多重试几次，
 * 达到目标就停——不是"定时守护"，只做这一次收敛。
 */
export async function applyWithRetry(geometry, { attempts = 4, gapMs = 260, titleMatch = DEFAULT_TITLE_MATCH, onAttempt } = {}) {
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    if (index > 0) await sleep(gapMs);
    last = applyGeometry(geometry, titleMatch);
    onAttempt?.(last, index + 1);
    if (!last.ok) {
      if (last.code === 'window-not-found') continue;
      return { ...last, attempts: index + 1 };
    }
    if (matches(geometry, last.after)) return { ...last, attempts: index + 1 };
  }
  return { ...(last ?? { ok: false, code: 'unknown' }), attempts };
}