/**
 * 落盘：本插件只拥有 `~/.dsh/window-size.json` 一个文件和一条可选日志。
 *
 * 读永远不抛：文件缺失、JSON 坏了、字段不全，一律返回 null，视作"没有保存过"——
 * 一份坏配置不该让客户端起不来。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置文件名（放在 DSH 主目录下）。 */
export const FILE_NAME = 'window-size.json';
/** 日志文件名（只记启动应用的结果，供排查用）。 */
export const LOG_NAME = 'window-size.log';
/** 日志上限：超过就只留最后 120 行，避免无限增长。 */
const LOG_MAX_BYTES = 64 * 1024;
const LOG_KEEP_LINES = 120;

/** DSH 主目录：配置项 > 环境变量 > ~/.dsh。 */
export function resolveHome(config = {}) {
  const configured = typeof config.home === 'string' ? config.home.trim() : '';
  if (configured) return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
  const fromEnv = String(process.env.DSH_HOME ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

export function configPath(config = {}) {
  const home = resolveHome(config);
  const file = typeof config.file === 'string' && config.file.trim() ? config.file.trim() : FILE_NAME;
  return path.join(home, file);
}

const integer = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

/**
 * 规整一份几何配置。宽高缺失或不是数字 → null（这份配置不能用）；
 * x/y 可以缺失（null 表示"位置交给客户端自己定"）。
 */
export function normalize(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const width = integer(input.width);
  const height = integer(input.height);
  if (width === null || height === null) return null;
  return {
    width,
    height,
    x: integer(input.x),
    y: integer(input.y),
    maximized: input.maximized === true,
    applyOnStart: input.applyOnStart !== false,
    savedAt: typeof input.savedAt === 'string' ? input.savedAt : null,
  };
}

/** 读配置。永不抛。 */
export function readConfig(config = {}) {
  const file = configPath(config);
  try {
    if (!existsSync(file)) return { config: null, error: null, file };
    return { config: normalize(JSON.parse(readFileSync(file, 'utf8'))), error: null, file };
  } catch (error) {
    return { config: null, error: error?.message ?? String(error), file };
  }
}

/** 写配置（先落临时文件再改名，避免半截 JSON）。 */
export function writeConfig(config = {}, value) {
  const file = configPath(config);
  const payload = normalize(value);
  if (payload === null) throw new Error('配置不完整：宽高必须是数字');
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, file);
  } catch {
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    try {
      unlinkSync(temporary);
    } catch {
      /* 临时文件删不掉不该让保存失败 */
    }
  }
  return { ...payload, file };
}

/** 删除保存的配置（= 回到客户端自己的默认尺寸）。 */
export function clearConfig(config = {}) {
  const file = configPath(config);
  try {
    if (existsSync(file)) unlinkSync(file);
    return { cleared: true, file };
  } catch (error) {
    return { cleared: false, file, error: error?.message ?? String(error) };
  }
}

/** 追加一行日志；永不抛。 */
export function appendLog(config = {}, line) {
  try {
    const file = path.join(resolveHome(config), LOG_NAME);
    mkdirSync(path.dirname(file), { recursive: true });
    let previous = '';
    try {
      previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
    } catch {
      previous = '';
    }
    let text = `${previous}${new Date().toISOString()} ${line}\n`;
    if (text.length > LOG_MAX_BYTES) text = text.split('\n').slice(-LOG_KEEP_LINES).join('\n');
    writeFileSync(file, text, 'utf8');
  } catch {
    /* 日志失败不影响功能 */
  }
}