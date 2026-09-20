'use strict';

/**
 * 把 dist 里的 zip 发布到 GitHub Release。
 *
 * 分三步做，而不是一把梭：
 *   1. 建 **draft** release —— 万一上传失败，页面上不会留下一个半成品 release
 *   2. 上传 zip 作为 asset
 *   3. 上传成功后才把 draft 转为正式发布
 *
 * 凭据处理：
 *   token 从 git 凭据助手（Windows 凭据管理器）现取，**不落盘、不打印、不进命令行**。
 *   传给 curl 走 `-K` 配置文件，避免出现在进程命令行里被其他进程看到。
 *   用完即删（finally 保证）。
 *
 * 用法：
 *   node tools/release.js --dry-run          # 只检查前置条件，不碰网络
 *   node tools/release.js                    # 正式发布
 *   node tools/release.js --draft-only       # 建 draft + 上传 asset，但不发布
 *   node tools/release.js --notes-only       # 只把 docs/releases/<tag>.md 刷到已有 release
 *   node tools/release.js --tag v1.0.1       # 指定 tag（默认取 package.json 的版本）
 *   node tools/release.js --asset <path>     # 指定要上传的 zip
 *
 * ⚠️ GitHub 会**静默剥掉** release asset 名里的非 ASCII 字符
 *   （「拾模-1.0.0-win-x64.zip」→「-1.0.0-win-x64.zip」），所以 asset 名必须 ASCII。
 *   这也是 package.json 里要有 assetBaseName 的原因。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagValue = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const DRY_RUN = hasFlag('--dry-run');
const DRAFT_ONLY = hasFlag('--draft-only');

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** 从 origin remote 推出 owner/repo。 */
function repoSlug() {
  const url = run('git', ['remote', 'get-url', 'origin']).stdout.trim();
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`无法从 origin 解析出 owner/repo：${url || '(空)'}`);
  return `${m[1]}/${m[2]}`;
}

/** 本机访问 GitHub 走本地代理更稳；没有配就直连。 */
function proxyOf() {
  return run('git', ['config', '--get', 'https.proxy']).stdout.trim();
}

/** 从凭据助手取 token。 */
function tokenOf() {
  const r = spawnSync('git', ['-c', 'credential.helper=wincred', 'credential', 'fill'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
  });
  const m = /^password=(.+)$/m.exec(r.stdout || '');
  if (!m) throw new Error('没取到 GitHub 凭据 —— Windows 凭据管理器里应有 git:https://github.com 条目');
  return m[1].trim();
}

/** 把 token 写进 curl 配置文件，避免出现在命令行。 */
function writeCurlConfig(token, proxy) {
  const file = path.join(os.tmpdir(), `shimo-release-${process.pid}.curlrc`);
  const lines = [
    'silent',
    'show-error',
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/vnd.github+json"',
    'header = "X-GitHub-Api-Version: 2022-11-28"',
    'user-agent = "shimo-release"',
  ];
  if (proxy) lines.push(`proxy = "${proxy}"`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

/** 调 GitHub API。body 为对象时按 JSON 发。 */
function api(cfg, method, url, { json, file, contentType, query } = {}) {
  const full = query ? `${url}?${query}` : url;
  const curlArgs = ['-K', cfg, '-X', method, '-w', '\n__HTTP__%{http_code}__TIME__%{time_total}'];
  if (json !== undefined) curlArgs.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (file) curlArgs.push('-H', `Content-Type: ${contentType}`, '--data-binary', `@${file}`);
  curlArgs.push(full);

  const r = spawnSync('curl', curlArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const out = r.stdout || '';
  const m = /__HTTP__(\d+)__TIME__([\d.]+)/.exec(out);
  const body = out.replace(/\n?__HTTP__[\s\S]*$/, '');
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* 非 JSON 响应，原样留着 */
  }
  return {
    status: r.status,
    http: m ? Number(m[1]) : 0,
    seconds: m ? Number(m[2]) : 0,
    body,
    json: parsed,
    stderr: r.stderr || '',
  };
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const tag = flagValue('--tag') || `v${pkg.version}`;
  const repo = repoSlug();
  const notesPath = path.join(ROOT, 'docs', 'releases', `${tag}.md`);
  const assetPath = flagValue('--asset') || path.join(ROOT, 'dist', `${pkg.assetBaseName || pkg.name}-${pkg.version}-win-x64.zip`);

  // 本地文件名可能是中文（「拾模-1.0.0-win-x64.zip」），但 GitHub 的 asset 名**必须** ASCII ——
  // 非 ASCII 会被它静默剥掉。所以这里显式转一次，并把映射打出来让人看得见。
  const rawName = path.basename(assetPath);
  const assetName = /^[\x20-\x7E]+$/.test(rawName) ? rawName : `${pkg.assetBaseName || pkg.name}-${pkg.version}-win-x64.zip`;

  const say = (s) => process.stdout.write(`${s}\n`);
  const notesOnly = hasFlag('--notes-only');

  say(`仓库      ${repo}`);
  say(`tag       ${tag}`);
  if (notesOnly) {
    say('asset     （--notes-only：只更新发布说明，不动附件）');
  } else {
    say(`asset     ${assetName}${fs.existsSync(assetPath) ? `  ${mb(fs.statSync(assetPath).size)}` : '  ❌ 不存在'}`);
    if (assetName !== rawName) say(`          本地文件是 ${rawName}；GitHub 的 asset 名必须 ASCII，上传时改名`);
  }
  say(`notes     docs/releases/${tag}.md${fs.existsSync(notesPath) ? '  ✅' : '  ❌ 不存在'}`);
  say('');

  if (!notesOnly && !fs.existsSync(assetPath)) throw new Error(`找不到 zip：${assetPath}\n先跑 node tools/archive.js 生成`);
  if (!fs.existsSync(notesPath)) throw new Error(`找不到发布说明：${notesPath}`);

  const notes = fs.readFileSync(notesPath, 'utf8');
  const proxy = proxyOf();
  say(`代理      ${proxy || '(未配置，直连)'}`);

  if (DRY_RUN) {
    say('\n--dry-run：前置条件齐备，未发起任何网络请求。');
    return 0;
  }

  const token = tokenOf();
  say(`凭据      已从凭据助手取到（长度 ${token.length}）\n`);

  const cfg = writeCurlConfig(token, proxy);
  try {
    if (notesOnly) {
      updateNotes(cfg, repo, tag, notes, say);
      return 0;
    }
    // 0. 先看 tag 是不是已经发过，避免重复
    const existing = api(cfg, 'GET', `https://api.github.com/repos/${repo}/releases/tags/${tag}`);
    if (existing.http === 200) {
      const rel = existing.json;
      say(`⚠️  tag ${tag} 已存在 release（id ${rel.id}，draft=${rel.draft}）`);
      say(`    ${rel.html_url}`);
      if (!hasFlag('--force')) {
        throw new Error('拒绝重复创建。要覆盖请先手动删除该 release，或加 --force 直接往已有 release 追加 asset');
      }
      const up = uploadAsset(cfg, repo, rel.id, assetPath, assetName);
      if (!DRAFT_ONLY) publish(cfg, repo, rel.id);
      return up;
    }

    // 1. 建 draft
    say('① 创建 draft release…');
    const created = api(cfg, 'POST', `https://api.github.com/repos/${repo}/releases`, {
      json: {
        tag_name: tag,
        target_commitish: 'main',
        name: `${pkg.productName} ${tag}`,
        body: notes,
        draft: true,
        prerelease: false,
      },
    });
    if (created.http !== 201) {
      throw new Error(`创建 release 失败：HTTP ${created.http}\n${created.body.slice(0, 600)}`);
    }
    const rel = created.json;
    say(`   ✅ draft 已创建 id=${rel.id}  ${rel.html_url}`);

    // 2. 上传 asset
    say(`② 上传 ${assetName}（${mb(fs.statSync(assetPath).size)}）…`);
    uploadAsset(cfg, repo, rel.id, assetPath, assetName);

    // 3. 发布
    if (DRAFT_ONLY) {
      say(`\n--draft-only：已停在 draft 状态。确认无误后到网页点 Publish，或去掉该参数重跑。`);
      return 0;
    }
    publish(cfg, repo, rel.id);
    return 0;
  } finally {
    // 配置文件里有 token，无论成败都要删
    try {
      fs.unlinkSync(cfg);
    } catch {
      /* 已删或删不掉都不影响结果 */
    }
  }
}

function uploadAsset(cfg, repo, releaseId, assetPath, assetName) {
  const localSize = fs.statSync(assetPath).size;

  // asset 名必须是 ASCII。GitHub 会**静默剥离**非 ASCII 字符：
  // 「拾模-1.0.0-win-x64.zip」上传后会变成「-1.0.0-win-x64.zip」，不报任何错。
  // 第一次发布就是这么被坑的，所以这里提前拦一道。
  if (!/^[\x20-\x7E]+$/.test(assetName)) {
    throw new Error(`asset 名含非 ASCII 字符：${assetName}\nGitHub 会把它静默剥掉。请用 ASCII 名（如 ${require(path.join(ROOT, 'package.json')).assetBaseName || 'ShiMo'}-x.y.z-win-x64.zip）`);
  }

  const started = Date.now();
  const r = api(cfg, 'POST', `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets`, {
    file: assetPath,
    contentType: 'application/zip',
    query: `name=${encodeURIComponent(assetName)}`,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.http !== 201) {
    throw new Error(`上传失败：HTTP ${r.http}（${secs}s）\n${(r.body || r.stderr).slice(0, 600)}`);
  }

  // 上传成功 ≠ 名字对。断言之，否则就是「发出去的包名和说好的不一样」还没人知道。
  const got = r.json.name;
  if (got !== assetName) {
    throw new Error(`上传后 asset 名被改动：请求「${assetName}」，GitHub 返回「${got}」。\n请到 release 页面确认并改回，或删除该 asset 重传。`);
  }
  const size = r.json.size || 0;
  if (size !== localSize) {
    throw new Error(`上传后体积不一致：本地 ${localSize} 字节，远程 ${size} 字节`);
  }

  const speed = secs ? `  平均 ${(size / 1024 / 1024 / Number(secs)).toFixed(1)} MB/s` : '';
  process.stdout.write(`   ✅ ${got}  ${mb(size)}  用时 ${secs}s${speed}\n`);
  return 0;
}

/**
 * 只刷新已有 release 的说明，不动附件。
 *
 * 为什么要单独一条路径：`PATCH /releases/{id}` 只认**数字 id**，不认 tag ——
 * 拿 `releases/tags/v1.0.0` 去 PATCH 会直接 404（GET 认 tag，PATCH 不认）。
 * 所以先 GET 一次取 id，再 PATCH。
 */
function updateNotes(cfg, repo, tag, notes, say) {
  const cur = api(cfg, 'GET', `https://api.github.com/repos/${repo}/releases/tags/${tag}`);
  if (cur.http !== 200) throw new Error(`tag ${tag} 还没有 release（HTTP ${cur.http}）`);
  const r = api(cfg, 'PATCH', `https://api.github.com/repos/${repo}/releases/${cur.json.id}`, { json: { body: notes } });
  if (r.http !== 200) throw new Error(`更新发布说明失败：HTTP ${r.http}\n${r.body.slice(0, 400)}`);
  say(`✅ 发布说明已更新（${r.json.body.length} 字符）  ${r.json.html_url}`);
}

function publish(cfg, repo, releaseId) {
  process.stdout.write('③ 转为正式发布…\n');
  const r = api(cfg, 'PATCH', `https://api.github.com/repos/${repo}/releases/${releaseId}`, { json: { draft: false } });
  if (r.http !== 200) throw new Error(`发布失败：HTTP ${r.http}\n${r.body.slice(0, 400)}`);
  process.stdout.write(`   ✅ 已发布  ${r.json.html_url}\n`);
}

try {
  process.exit(main() ?? 0);
} catch (err) {
  process.stderr.write(`\n❌ ${err.message}\n`);
  process.exit(1);
}
