'use strict';

/**
 * 完整性校验（FR-05）。
 *
 * 存在的意义：把「打开失败」从 Cubism Editor 里前移到导出之前。
 * 用户在编辑器里看到的是一句 `csmReviveMocInPlace is failed`，看不出缺了什么；
 * 在这里我们能明确告诉他「缺 minori_normal.2048/texture_01.png」。
 *
 * 分级（严格照 PRD 表格）：
 *   错误 → 缺 .moc3 / 缺纹理图集 → 残留包，默认不勾选
 *   警告 → 无动作                  → 「无动作」，默认不勾选
 *   警告 → 无表情                  → 「无表情」，仍可勾选
 *   提示 → .moc3 版本高于本机承受范围 → 导出完成页给兼容性提示
 */

/** `.moc3` 头部：前 4 字节为魔数 MOC3，第 5 字节为格式版本。 */
const MOC3_MAGIC = 'MOC3';

/**
 * moc3 格式版本 → 需要的 Cubism Editor 下限。
 * 依据：官方文档明确「新版 Core 向后兼容全部历史 moc3 版本，反之不行」，
 * 以及社区实测报错 `The Core unsupported later than moc3 ver:[3]. This moc3 ver is [4].`
 */
const MOC3_VERSION_SUPPORT = {
  3: { label: 'moc3 ver 3', minEditor: 'Cubism 3.0', worksWith: 'Cubism 3 / 4 / 5', note: '' },
  4: {
    label: 'moc3 ver 4',
    minEditor: 'Cubism 4.2',
    worksWith: 'Cubism 4.2 / 5',
    note: '需 Cubism Editor 4.2 或更高版本；旧版编辑器会出现「Core 不支持」且无详细原因',
  },
  5: { label: 'moc3 ver 5', minEditor: 'Cubism 5.0', worksWith: 'Cubism 5', note: '需 Cubism Editor 5.0 或更高版本' },
};

function bufferToHex(buffer, length = 8) {
  const slice = buffer.subarray(0, Math.min(length, buffer.length));
  return [...slice].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/**
 * 读取 .moc3 版本。
 * 文件头损坏或魔数不符时返回 valid:false —— 不能默默当成「版本 0」，
 * 那会让用户拿一个损坏的文件去导出。
 */
function readMoc3Header(buffer) {
  if (!buffer || buffer.length < 5) {
    return { valid: false, magic: null, version: null, reason: '文件长度不足 5 字节，无法读取 MOC3 文件头', hex: buffer ? bufferToHex(buffer) : '' };
  }
  const magic = buffer.subarray(0, 4).toString('latin1');
  if (magic !== MOC3_MAGIC) {
    return {
      valid: false,
      magic,
      version: null,
      reason: `文件头魔数不是 MOC3（实际为 ${JSON.stringify(magic)}）`,
      hex: bufferToHex(buffer),
    };
  }
  return { valid: true, magic, version: buffer[4], hex: bufferToHex(buffer), reason: '' };
}

/**
 * 校验单个运行时包。
 *
 * @param {object} pack buildPack 的产物
 * @param {object} [moc3Header] 已读取的 moc3 头部（可选，未提供则不做版本判断）
 * @returns {object} 校验结果
 */
function validatePack(pack, moc3Header = null) {
  const issues = [];

  const missingMoc3 = (pack.missing || []).filter((m) => m.role === 'moc3');
  const missingTextures = (pack.missing || []).filter((m) => m.role === 'texture');
  const otherMissing = (pack.missing || []).filter((m) => m.role !== 'moc3' && m.role !== 'texture');

  if (pack.parseError) {
    issues.push({ level: 'error', code: 'MANIFEST_UNPARSEABLE', message: pack.parseError, target: pack.entryPath });
  }

  for (const m of missingMoc3) {
    issues.push({
      level: 'error',
      code: 'MISSING_MOC3',
      message: `清单引用的模型本体不存在：${m.relPath}`,
      target: m.absPath,
    });
  }
  for (const m of missingTextures) {
    issues.push({
      level: 'error',
      code: 'MISSING_TEXTURE',
      message: `清单引用的纹理图集不存在：${m.relPath}`,
      target: m.absPath,
    });
  }
  for (const m of otherMissing) {
    // 缺动作 / 表情 / 物理文件属于警告级：模型仍能打开，只是少了功能
    issues.push({
      level: 'warning',
      code: `MISSING_${(m.role || 'FILE').toUpperCase()}`,
      message: `清单引用的 ${m.role} 文件不存在：${m.relPath}`,
      target: m.absPath,
    });
  }

  if (!pack.parseError && pack.missing.length === 0 && !pack.moc3Path) {
    issues.push({
      level: 'error',
      code: 'NO_MOC3_REFERENCE',
      message: '清单中没有 Moc 字段，无法确定模型本体',
      target: pack.entryPath,
    });
  }

  if (!pack.hasMotions) {
    issues.push({
      level: 'warning',
      code: 'NO_MOTIONS',
      message: '包内没有动作文件（motions），导入后模型不会有任何动态',
      target: pack.entryDir,
    });
  }
  if (!pack.hasExpressions) {
    issues.push({
      level: 'warning',
      code: 'NO_EXPRESSIONS',
      message: '包内没有表情文件（expressions），不影响打开',
      target: pack.entryDir,
    });
  }

  // moc3 版本兼容性（提示级，不阻止导出，但在导出完成页明确告知）
  let moc3Version = null;
  let moc3Compat = null;
  if (moc3Header) {
    if (!moc3Header.valid) {
      issues.push({
        level: 'error',
        code: 'MOC3_HEADER_INVALID',
        message: `模型本体文件头异常：${moc3Header.reason}`,
        target: pack.moc3Path,
      });
    } else {
      moc3Version = moc3Header.version;
      moc3Compat = MOC3_VERSION_SUPPORT[moc3Version] || {
        label: `moc3 ver ${moc3Version}`,
        minEditor: '未知',
        worksWith: '未知',
        note: `这是未在文档中出现过的 moc3 版本（${moc3Version}），请确认使用的 Cubism Editor 版本`,
      };
      const editorMax = moc3Header.editorMaxVersion;
      if (editorMax !== undefined && editorMax !== null && moc3Version > editorMax) {
        issues.push({
          level: 'notice',
          code: 'MOC3_VERSION_TOO_NEW',
          message:
            `该模型为 ${moc3Compat.label}，需要 ${moc3Compat.minEditor} 或更高版本才能打开；` +
            `本机检测到的编辑器最高支持 moc3 ver ${editorMax}。旧版本会直接拒绝加载且不给出可读原因。`,
          target: pack.moc3Path,
        });
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const notices = issues.filter((i) => i.level === 'notice');

  const status = deriveStatus({ errors, warnings, pack });
  const defaultChecked = errors.length === 0 && pack.hasMotions && !pack.parseError;

  return {
    packId: pack.id,
    status: status.code,
    statusLabel: status.label,
    statusLevel: status.level,
    defaultChecked,
    issues,
    errorCount: errors.length,
    warningCount: warnings.length,
    noticeCount: notices.length,
    moc3Version,
    moc3Compat,
    // 状态列的 tooltip 文案：把具体缺了什么说出来
    statusDetail: issues.length ? issues.map((i) => i.message).join('；') : '全部引用文件均已就位',
  };
}

/**
 * 状态列的单一标签。FR-05 验收点要求「直接显示校验结果而非统一显示有风险」，
 * 所以这里按严重度取第一个命中的具体标签。
 */
function deriveStatus({ errors, warnings, pack }) {
  if (pack.parseError) return { code: 'broken', label: '清单损坏', level: 'error' };
  const hasError = (code) => errors.some((e) => e.code === code);
  if (hasError('MISSING_MOC3')) return { code: 'missing_moc3', label: '缺 moc3', level: 'error' };
  if (hasError('MISSING_TEXTURE')) return { code: 'missing_texture', label: '缺纹理', level: 'error' };
  if (hasError('MOC3_HEADER_INVALID')) return { code: 'broken', label: '本体损坏', level: 'error' };
  if (hasError('NO_MOC3_REFERENCE')) return { code: 'missing_moc3', label: '缺 moc3', level: 'error' };
  if (errors.length > 0) return { code: 'incomplete', label: '缺文件', level: 'error' };
  if (warnings.some((w) => w.code === 'NO_MOTIONS')) return { code: 'no_motions', label: '无动作', level: 'warning' };
  if (warnings.some((w) => w.code === 'NO_EXPRESSIONS')) return { code: 'no_expressions', label: '无表情', level: 'warning' };
  if (warnings.length > 0) return { code: 'incomplete', label: '缺文件', level: 'warning' };
  return { code: 'complete', label: '完整', level: 'ok' };
}

/**
 * 渲染 manifest.txt（FR-05 / FR-07 验收点：校验结果需写入导出目录，便于事后追溯）。
 * 这个文件是纯文本，面向人读，所以列成对齐的表格而不是 JSON。
 */
function buildManifestText({ pack, validation, source, exportedAt, toolVersion, savedRoot, cancelledNote }) {
  const lines = [];
  const rule = '='.repeat(64);
  lines.push(rule);
  lines.push('拾模 · 运行时包导出清单');
  lines.push(rule);
  lines.push('');
  lines.push('[来源]');
  lines.push(`  模拟器实例    ${source.instanceName || '—'}`);
  lines.push(`  ADB 地址      ${source.adbAddress || source.serial || '—'}`);
  lines.push(`  Android 版本  ${source.androidVersion || '—'}`);
  lines.push(`  应用包名      ${source.packageName || '—'}`);
  lines.push(`  设备内路径    ${pack.entryDir}`);
  lines.push('');
  lines.push('[导出]');
  lines.push(`  导出时间      ${exportedAt}`);
  lines.push(`  导出位置      ${savedRoot}`);
  lines.push(`  工具版本      拾模 ${toolVersion}`);
  lines.push('');
  lines.push('[模型]');
  lines.push(`  模型名        ${pack.modelName}`);
  lines.push(`  入口文件      ${pack.entryPath.split('/').pop()}  ← Cubism Editor 打开这个`);
  lines.push(`  动作数        ${pack.motions}${pack.motionGroups.length ? `（${pack.motionGroups.join(' / ')}）` : ''}`);
  lines.push(`  表情数        ${pack.expressions}`);
  lines.push(`  纹理数        ${pack.textureCount}`);
  lines.push(`  体积          ${pack.totalBytes} 字节`);
  if (validation.moc3Version !== null && validation.moc3Version !== undefined) {
    lines.push(`  moc3 版本     ${validation.moc3Version}（需 ${validation.moc3Compat ? validation.moc3Compat.minEditor : '未知'} 或更高）`);
  }
  lines.push('');
  lines.push('[完整性校验]');
  lines.push(`  结论          ${validation.statusLabel}`);
  if (validation.issues.length === 0) {
    lines.push('  全部引用文件均已就位。');
  } else {
    for (const issue of validation.issues) {
      const tag = issue.level === 'error' ? '错误' : issue.level === 'warning' ? '警告' : '提示';
      lines.push(`  [${tag}] ${issue.message}`);
      if (issue.target) lines.push(`         对象：${issue.target}`);
    }
  }
  lines.push('');
  lines.push('[文件清单]');
  const sorted = [...pack.files].sort((a, b) => String(a.exportRelPath || a.relPath).localeCompare(String(b.exportRelPath || b.relPath)));
  for (const f of sorted) {
    const rel = f.exportRelPath || f.relPath;
    lines.push(`  ${String(f.size).padStart(10)}  ${rel}`);
  }
  lines.push('');
  if (cancelledNote) {
    lines.push('[注意]');
    lines.push(`  ${cancelledNote}`);
    lines.push('');
  }
  lines.push('本文件由拾模自动生成，用于追溯导出内容的来源与完整性结论。');
  lines.push('模型版权归原游戏与原作者所有，请勿用于商业用途。');
  lines.push('');
  return lines.join('\r\n');
}

module.exports = {
  MOC3_MAGIC,
  MOC3_VERSION_SUPPORT,
  readMoc3Header,
  validatePack,
  deriveStatus,
  buildManifestText,
  bufferToHex,
};
