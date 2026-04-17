/**
 * build.js
 * 각 확장 프로그램의 소스를 난독화, 압축하여 dist/<이름>/ 에 출력한다.
 *
 * 사전 준비:
 *   npm install                   # 최초 1회 의존 패키지 설치
 *
 * 사용법:
 *   node build.js google-search   # google-search 빌드
 *   node build.js naver-cookies   # naver-cookies 빌드
 *   node build.js naver-products  # naver-products 빌드
 *
 * 처리 내용:
 *   JS: javascript-obfuscator (난독화 + 코드 압축)
 *   HTML: html-minifier-terser (공백/주석 제거)
 *   CSS: clean-css (공백/주석 제거)
 *   JSON: JSON.parse+stringify (공백 제거)
 *   그 외: 파일 그대로 복사
 */

'use strict';

const fs = require('fs');
const path = require('path');

const JavaScriptObfuscator = require('javascript-obfuscator');
const { minify: minifyHtml } = require('html-minifier-terser');
const CleanCSS = require('clean-css');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// 빌드에서 제외할 파일/폴더
const IGNORE = new Set(['README.md', 'LICENSE', '.gitignore', 'node_modules', 'package.json', 'package-lock.json', 'docs', 'dist', 'env', 'temp']);

// 유틸리티

function rimraf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rimraf(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

function kb(input) {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input;
  return (bytes / 1024).toFixed(1) + 'KB';
}

function totalSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += totalSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

// JS 난독화 옵션

const JS_OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  rotateStringArray: true,
  selfDefending: true,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  target: 'browser',
};

// 재귀 빌드

async function processDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;

    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await processDir(srcPath, destPath);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();

    if (ext === '.js') {
      const src = fs.readFileSync(srcPath, 'utf8');
      const result = JavaScriptObfuscator.obfuscate(src, JS_OBFUSCATOR_OPTIONS);
      fs.writeFileSync(destPath, result.getObfuscatedCode(), 'utf8');
      const srcSz = Buffer.byteLength(src, 'utf8');
      const destSz = Buffer.byteLength(result.getObfuscatedCode(), 'utf8');
      console.log(`  [JS]   ${entry.name}: ${kb(srcSz)} → ${kb(destSz)}`);
    } else if (ext === '.html') {
      const src = fs.readFileSync(srcPath, 'utf8');
      const out = await minifyHtml(src, {
        collapseWhitespace: true,
        removeComments: true,
        removeEmptyAttributes: true,
        minifyCSS: true,
        minifyJS: true,
      });
      fs.writeFileSync(destPath, out, 'utf8');
      console.log(`  [HTML] ${entry.name}: ${kb(src)} → ${kb(out)}`);
    } else if (ext === '.css') {
      const src = fs.readFileSync(srcPath, 'utf8');
      const out = new CleanCSS({ level: 2 }).minify(src).styles;
      fs.writeFileSync(destPath, out, 'utf8');
      console.log(`  [CSS]  ${entry.name}: ${kb(src)} → ${kb(out)}`);
    } else if (ext === '.json') {
      const src = fs.readFileSync(srcPath, 'utf8');
      try {
        const out = JSON.stringify(JSON.parse(src));
        fs.writeFileSync(destPath, out, 'utf8');
        console.log(`  [JSON] ${entry.name}: ${kb(src)} → ${kb(out)}`);
      } catch {
        fs.copyFileSync(srcPath, destPath);
        console.log(`  [JSON] ${entry.name}: 파싱 실패, 그대로 복사`);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  [COPY] ${entry.name}`);
    }
  }
}

// 메인

(async () => {
  const target = process.argv[2];

  if (!target) {
    console.error('사용법: node build.js <확장프로그램 폴더명>');
    console.error('예시 : node build.js naver-cookies');
    process.exit(1);
  }

  // <target>/ 이 소스 폴더 (manifest.json이 바로 아래에 위치)
  const srcDir = path.join(ROOT, target);
  const destDir = path.join(DIST, target);

  if (!fs.existsSync(srcDir)) {
    console.error(`소스 폴더가 없습니다: ${srcDir}`);
    process.exit(1);
  }

  console.log(`=== ${target} 난독화 빌드 ===`);
  console.log(`SRC : ${srcDir}`);
  console.log(`DEST: ${destDir}\n`);

  rimraf(destDir);
  fs.mkdirSync(destDir, { recursive: true });

  try {
    await processDir(srcDir, destDir);

    const srcTotal = totalSize(srcDir);
    const destTotal = totalSize(destDir);
    console.log(`\n원본: ${kb(srcTotal)} → 빌드: ${kb(destTotal)} (${((destTotal / srcTotal - 1) * 100).toFixed(0)}%)`);
    console.log('=== 빌드 완료 ===');
  } catch (err) {
    console.error('빌드 오류:', err.message);
    process.exit(1);
  }
})();