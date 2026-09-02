/**
 * scripts/start.js — 启动包装器
 *
 * 背景：
 *   沙箱环境全局设置了 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成 Node 模式
 *   （process.type === undefined、require('electron') 返回二进制路径字符串）。
 *
 *   本脚本在启动 Electron 之前显式 unset 该变量，确保进入主进程模式。
 *
 * 用法：
 *   npm start
 *   npm run dev
 *   node scripts/start.js [传给 electron 的额外参数...]
 */
const { spawn } = require('child_process');
const path = require('path');

const electronCli = require.resolve('electron/cli.js');

// 默认传入 '.'（项目根目录），允许自定义
const userArgs = process.argv.slice(2);
const args = userArgs.length ? userArgs : ['.'];

// 关键：必须在 spawn env 中彻底删掉 ELECTRON_RUN_AS_NODE，
// 因为 Electron 把空字符串也视为已设置，会强制进入 Node 模式。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ELECTRON_NO_ATTACH_CONSOLE = '1';
env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const child = spawn(process.execPath, [electronCli, ...args], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (code === null) {
    console.error('[start] electron exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});