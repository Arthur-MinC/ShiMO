'use strict';

/**
 * Cubism Editor 探测与调起（FR-08）。
 *
 * 桌面端最爽的一点在这儿：Cubism Editor 就在同一台机器上，
 * 所以最后一步不该是「告诉你文件在哪」，而是直接把编辑器调起来。
 *
 * 两个必须守住的细节：
 *   - 传进去的必须是 `.model3.json`，不是 `.moc3`。界面上也要用文字写明这一点，
 *     这是新手最常踩的坑 —— 拿 .moc3 去打开只会得到一句无法理解的报错。
 *   - 没装编辑器时要降级成「打开文件夹」+「复制路径」，并给下载指引，
 *     而不是抛一个「未找到 Cubism Editor」的死胡同。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const DOWNLOAD_URL = 'https://www.live2d.com/download/cubism/';

/** Cubism Editor 主程序文件名形态：CubismEditor5.exe / CubismEditor4.exe / CubismEditor.exe */
const EDITOR_EXE_PATTERN = /^CubismEditor\d*\.exe$/i;

/** 常见安装位置模板。{v} 会被替换为主版本号。 */
const INSTALL_TEMPLATES = [
  'C:\\Program Files\\Live2D Cubism {v}\\Cubism Editor {v}',
  'C:\\Program Files\\Live2D Cubism {v}',
  'C:\\Program Files (x86)\\Live2D Cubism {v}\\Cubism Editor {v}',
  'C:\\Program Files\\Live2D Cubism {v}\\Cubism Editor {v}\\CubismEditor{v}.exe',
];

let cachedResult = null;

/** 在给定目录（限深度）内找 Cubism Editor 主程序。 */
async function findEditorExe(rootDir, maxDepth = 3) {
  const stack = [{ d: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const { d, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isFile() && EDITOR_EXE_PATTERN.test(entry.name)) return full;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push({ d: path.join(d, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

/** 查注册表的卸载信息，拿到安装位置与显示图标路径。 */
function queryRegistry() {
  return new Promise((resolve) => {
    const script =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      "$keys = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); " +
      'Get-ItemProperty $keys -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.DisplayName -like "*Cubism*" } | ' +
      'Select-Object DisplayName,DisplayVersion,InstallLocation,DisplayIcon | ConvertTo-Json -Compress -Depth 2';

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, entries: [], message: err.message });
          return;
        }
        try {
          const text = String(stdout).trim();
          if (!text) {
            resolve({ ok: true, entries: [], message: '' });
            return;
          }
          const parsed = JSON.parse(text);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          resolve({
            ok: true,
            entries: list
              .filter((e) => e && e.DisplayName)
              .map((e) => ({
                displayName: String(e.DisplayName),
                displayVersion: e.DisplayVersion ? String(e.DisplayVersion) : '',
                installLocation: e.InstallLocation ? String(e.InstallLocation) : '',
                displayIcon: e.DisplayIcon ? String(e.DisplayIcon) : '',
              })),
            message: '',
          });
        } catch (parseErr) {
          resolve({ ok: false, entries: [], message: `解析注册表结果失败：${parseErr.message}` });
        }
      }
    );
  });
}

/** 从 DisplayIcon 字段里剥出真正的 exe 路径。该字段常形如 `C:\..\x.exe,0`。 */
function exeFromDisplayIcon(displayIcon) {
  if (!displayIcon) return null;
  const cleaned = displayIcon.replace(/,\d+$/, '').replace(/^"|"$/g, '').trim();
  if (!cleaned) return null;
  if (!/\.exe$/i.test(cleaned)) return null;
  try {
    if (fs.existsSync(cleaned)) return cleaned;
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 提取主版本号，用于生成常见路径模板。 */
function majorVersionOf(displayVersion) {
  const m = /(\d+)/.exec(String(displayVersion || ''));
  return m ? Number(m[1]) : null;
}

/**
 * 探测 Cubism Editor。
 * 结果会被缓存 —— 探测要开 PowerShell，没必要每次都做。
 *
 * @param {object} [options]
 * @param {boolean} [options.force] 强制重新探测
 * @param {string} [options.extraPath] 用户手动指定的编辑器路径
 */
async function detectCubismEditor(options = {}) {
  if (cachedResult && !options.force && !options.extraPath) return cachedResult;

  // 用户手动指定优先
  if (options.extraPath) {
    const manual = await validateEditorPath(options.extraPath);
    if (manual.ok) {
      cachedResult = {
        found: true,
        source: 'manual',
        exePath: manual.exePath,
        displayName: path.basename(manual.exePath, '.exe'),
        version: null,
        downloadUrl: DOWNLOAD_URL,
        candidates: [manual.exePath],
      };
      return cachedResult;
    }
  }

  const candidates = [];
  const notes = [];

  // 1) 注册表
  const reg = await queryRegistry();
  if (reg.ok) {
    for (const entry of reg.entries) {
      const iconExe = exeFromDisplayIcon(entry.displayIcon);
      if (iconExe && EDITOR_EXE_PATTERN.test(path.basename(iconExe))) {
        candidates.push({ path: iconExe, source: 'registry', displayName: entry.displayName, version: entry.displayVersion });
      }
      if (entry.installLocation) {
        const found = await findEditorExe(entry.installLocation);
        if (found) {
          candidates.push({ path: found, source: 'registry', displayName: entry.displayName, version: entry.displayVersion });
        }
      }
    }
  } else {
    notes.push(`读取注册表失败：${reg.message}`);
  }

  // 2) 常见安装路径（覆盖注册表缺失或绿色安装的情况）
  if (candidates.length === 0) {
    const versions = [6, 5, 4, 3];
    for (const v of versions) {
      for (const tpl of INSTALL_TEMPLATES) {
        const p = tpl.replace(/\{v\}/g, String(v));
        if (p.toLowerCase().endsWith('.exe')) {
          try {
            if (fs.existsSync(p)) candidates.push({ path: p, source: 'common-path', displayName: `Live2D Cubism ${v}`, version: String(v) });
          } catch {
            /* 忽略 */
          }
        } else {
          const found = await findEditorExe(p, 2);
          if (found) {
            candidates.push({ path: found, source: 'common-path', displayName: `Live2D Cubism ${v}`, version: String(v) });
          }
        }
      }
      if (candidates.length > 0) break;
    }
  }

  // 去重
  const seen = new Set();
  const unique = candidates.filter((c) => {
    const k = c.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (unique.length === 0) {
    cachedResult = {
      found: false,
      source: null,
      exePath: null,
      displayName: null,
      version: null,
      downloadUrl: DOWNLOAD_URL,
      candidates: [],
      notes,
    };
    return cachedResult;
  }

  // 版本高的优先
  unique.sort((a, b) => (majorVersionOf(b.version) || 0) - (majorVersionOf(a.version) || 0));
  cachedResult = {
    found: true,
    source: unique[0].source,
    exePath: unique[0].path,
    displayName: unique[0].displayName || path.basename(unique[0].path, '.exe'),
    version: unique[0].version || null,
    downloadUrl: DOWNLOAD_URL,
    candidates: unique.map((c) => c.path),
    notes,
  };
  return cachedResult;
}

/** 校验一个用户给定的路径是不是可用的编辑器主程序。 */
async function validateEditorPath(p) {
  if (!p) return { ok: false, message: '未提供路径' };
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return { ok: false, message: '该路径不是文件' };
    if (!/\.exe$/i.test(p)) return { ok: false, message: '请选择 Cubism Editor 的可执行文件（.exe）' };
    return { ok: true, exePath: p };
  } catch (err) {
    return { ok: false, message: `路径不可访问：${err.message}` };
  }
}

/**
 * 用已探测到的编辑器打开一个模型。
 *
 * @param {string} exePath 编辑器主程序
 * @param {string} model3JsonPath 目标 `.model3.json`（**不是** .moc3）
 */
function launchEditor(exePath, model3JsonPath) {
  return new Promise((resolve) => {
    if (!exePath) {
      resolve({ ok: false, message: '尚未检测到 Cubism Editor' });
      return;
    }
    if (!/\.model3\.json$/i.test(model3JsonPath || '')) {
      resolve({
        ok: false,
        message: '要打开的是 .model3.json 清单文件，不是 .moc3。请确认传入的路径。',
      });
      return;
    }
    try {
      const child = spawn(exePath, [model3JsonPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.on('error', (err) => {
        resolve({ ok: false, message: `启动失败：${err.message}` });
      });
      child.unref();
      // spawn 成功即认为已交给系统；编辑器自身的加载失败无法从这里感知
      resolve({ ok: true, exePath, model: model3JsonPath });
    } catch (err) {
      resolve({ ok: false, message: `启动失败：${err.message}` });
    }
  });
}

/** 清空缓存（用户手动指定路径后需要重新探测时用）。 */
function resetCache() {
  cachedResult = null;
}

module.exports = {
  DOWNLOAD_URL,
  EDITOR_EXE_PATTERN,
  INSTALL_TEMPLATES,
  detectCubismEditor,
  findEditorExe,
  queryRegistry,
  exeFromDisplayIcon,
  validateEditorPath,
  launchEditor,
  resetCache,
};
