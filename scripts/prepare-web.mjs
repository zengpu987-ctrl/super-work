#!/usr/bin/env node
/** 把离线 Three.js 模块复制到 web 的 /vendor 目录（生成式 3D 预览用，禁止 CDN）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "apps/web");
const vendorDir = path.join(webDir, "public", "vendor");
fs.mkdirSync(vendorDir, { recursive: true });

function copyOptional(entryName, outName) {
  const direct = path.join(webDir, "node_modules", "three", entryName);
  if (!fs.existsSync(direct)) return false;
  return copy(entryName, outName);
}

function copy(entryName, outName) {
  const direct = path.join(webDir, "node_modules", "three", entryName);
  try {
    fs.copyFileSync(direct, path.join(vendorDir, outName));
    console.log(`[prepare-web] ${entryName} -> public/vendor/${outName}`);
    return true;
  } catch (error) {
    console.warn(`[prepare-web] 无法复制 three/${entryName}：${error.message}`);
    return false;
  }
}

copy("build/three.module.js", "three.module.js");
// 部分 three 版本会把核心拆到 three.core.js；存在就一起复制，不存在时静默跳过。
copyOptional("build/three.core.js", "three.core.js");
const indexPath = path.join(vendorDir, "three.module.js");
if (fs.existsSync(indexPath)) {
  const size = fs.statSync(indexPath).size;
  console.log(`[prepare-web] vendor ready (${(size / 1024).toFixed(0)} KB)`);
}
