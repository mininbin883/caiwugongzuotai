#!/usr/bin/env node
'use strict';

// 加固 Windows 程序包（打包时运行，参数为解压后的程序目录，里面有 墨隐本地脱敏.exe 和 resources/app.asar）：
// 1. 把 app.asar 头部的 SHA-256 写进 exe 资源（INTEGRITY/ELECTRONASAR），并开启 asar 完整性校验：app.asar 被改动就拒绝启动；
// 2. 只允许从 app.asar 加载程序；
// 3. 关闭 RunAsNode、NODE_OPTIONS 和 --inspect 调试参数，避免绕过程序逻辑（包括授权核对）。
// 可选第二个参数：图标 .ico，先替换 exe 的程序图标（必须在写入完整性资源之前）。
// 与 electron-builder 使用同一套实现（app-builder-lib 的 computeData / addWinAsarIntegrity 和 @electron/fuses）。

const path = require('node:path');
const fs = require('node:fs');
const { computeData } = require('app-builder-lib/out/asar/integrity');
const { addWinAsarIntegrity } = require('app-builder-lib/out/electron/electronWin');
const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = require('@electron/fuses');
const ResEdit = require('resedit');

function replaceIcon(exePath, iconPath) {
  const executable = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const resource = ResEdit.NtExecutableResource.from(executable);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries);
  if (!groups.length) throw new Error('exe 里没有图标资源');
  for (const group of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resource.entries, group.id, group.lang, icon.icons.map((item) => item.data));
  }
  resource.outputResource(executable);
  fs.writeFileSync(exePath, Buffer.from(executable.generate()));
}

async function main() {
  const directory = path.resolve(process.argv[2] || '.');
  const exe = fs.readdirSync(directory).find((name) => name.endsWith('.exe') && !/^unins/iu.test(name));
  if (!exe) throw new Error(`没有找到 exe：${directory}`);
  const exePath = path.join(directory, exe);
  if (process.argv[3]) replaceIcon(exePath, path.resolve(process.argv[3]));
  const resourcesPath = path.join(directory, 'resources');
  const integrity = await computeData({ resourcesPath, resourcesRelativePath: 'resources' });
  if (!Object.keys(integrity).some((file) => file.endsWith('app.asar'))) throw new Error('resources 里没有 app.asar');
  await addWinAsarIntegrity(exePath, integrity);
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  });
  const wire = await getCurrentFuseWire(exePath);
  const names = Object.fromEntries(Object.entries(FuseV1Options).filter(([, value]) => typeof value === 'number').map(([name, value]) => [value, name]));
  const state = Object.fromEntries(Object.entries(wire).filter(([key]) => key !== 'version').map(([key, value]) => [names[key] || key, value]));
  process.stdout.write(`${JSON.stringify({ exe, integrity, fuses: state }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`HARDEN_FAILED ${error.stack || error}\n`);
  process.exitCode = 1;
});
