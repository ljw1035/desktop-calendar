/**
 * scripts/build.js — 打包脚本
 *
 * 职责：
 *   1. 重新生成 assets/icon.ico / tray.png（保证图标和代码同步）
 *   2. 设置 SSL 跳过和淘宝镜像
 *   3. 调用 electron-builder 打包
 *
 * 用法：
 *   npm run build       — 默认 portable 单文件 exe
 *   npm run build:dir   — 只生成 win-unpacked 目录（更快，便于调试）
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

console.log('[build] 步骤 1/2：生成图标');
const iconGen = spawnSync(process.execPath, [path.join(__dirname, 'gen-icon.js')], {
  stdio: 'inherit',
});
if (iconGen.status !== 0) {
  console.error('[build] 图标生成失败');
  process.exit(1);
}

console.log('\n[build] 步骤 2/2：electron-builder 打包（portable 目标）');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;            // 不能置空串，Electron 把空串当已设置
env.NODE_TLS_REJECT_UNAUTHORIZED = '0';     // 跳过 SSL 校验
env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const isDir = process.argv.includes('--dir');
const args = ['electron-builder', '--win', '--x64', '--publish', 'never'];
if (isDir) args.push('--dir');

const builderBin = path.join(
  path.dirname(require.resolve('electron-builder/package.json')),
  'out', 'cli', 'cli.js'
);

const r = spawnSync(process.execPath, [builderBin, ...args], { stdio: 'inherit', env });
process.exit(r.status || 0);