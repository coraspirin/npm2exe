const fs = require('fs');
const path = require('path');
const { analyzeCommand } = require('./commandAnalyzer');

// Node 20 Nisan 2026'da EOL oldu; hiçbir kaynaktan versiyon çıkmazsa (uyarıyla) bu kullanılır.
const DEFAULT_NODE_MAJOR = 22;
const ENTRY_EXTENSIONS = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs', '/index.mjs'];
const SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts']);
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output']);
const SCAN_MAX_FILES = 500;

const SSR_DEPENDENCIES = { next: 'next', nuxt: 'nuxt', '@sveltejs/kit': 'sveltekit', '@remix-run/serve': 'remix', astro: 'astro' };
const SERVER_DEPENDENCIES = { express: 'express', fastify: 'fastify', koa: 'koa', '@nestjs/core': 'nestjs', '@hapi/hapi': 'hapi' };
// Kökteki package.json başlatılabilir değilse (workspace kökü, sadece script'ler) uygulama bu alt klasörlerde aranır.
const APP_SUBDIRS = ['server', 'backend', 'api', 'app'];

/**
 * Web servisinin entry point'ini, portunu, Node versiyonunu ve framework'ünü tespit eder.
 * Soru sorulmaz; tespit edilemeyen her şey `errors` listesine düşer (toplu pre-flight raporu için).
 *
 * @param {object} webService projectModel çıktısındaki uygulama servisi
 * @param {{ entry?: string, port?: number, rootDir?: string }} overrides CLI'dan gelen açık değerler;
 *   rootDir: mesajlarda yolların göreli gösterileceği proje kökü (temp workspace)
 */
function detectStack(webService, overrides = {}) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const appDir = resolveAppDir(webService.build.context);
  if (appDir !== webService.build.context) {
    infos.push(`Uygulama klasörü: ${displayPath(overrides.rootDir, appDir)} (kökteki package.json'da başlatma komutu yok)`);
  }

  const pkgPath = path.join(appDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    errors.push(`Seçilen klasör bir Node.js projesi değil: ${displayPath(overrides.rootDir, pkgPath) || 'package.json'} bulunamadı`);
    return { appDir, packageJson: null, entry: null, port: null, node: null, framework: null, errors, warnings, infos };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    errors.push(`package.json parse edilemedi: ${err.message}`);
    return { appDir, packageJson: null, entry: null, port: null, node: null, framework: null, errors, warnings, infos };
  }

  const framework = detectFramework(pkg);
  const entry = detectEntry({ appDir, pkg, override: overrides.entry, errors, warnings, infos });
  const port = detectPort({ webService, appDir, entry, override: overrides.port, errors, warnings });
  const node = detectNodeVersion(pkg, [appDir, webService.build.context], warnings);

  if (framework.ssr && !(entry && entry.kind === 'ssr')) {
    warnings.push(`${framework.ssr} bağımlılığı var ama başlatma komutu SSR sunucusu değil — frontend build aşamasında ayrıca ele alınacak`);
  }

  return {
    appDir,
    packageJson: { name: pkg.name || null, version: pkg.version || null },
    entry,
    port,
    node,
    framework,
    errors,
    warnings,
    infos
  };
}

/**
 * Uygulama klasörü: kökteki package.json başlatılabilirse (scripts.start / main) kök; değilse
 * server/, backend/, api/, app/ alt klasörlerinden başlatılabilir package.json içeren ilki.
 */
function resolveAppDir(root) {
  if (isRunnable(readPackage(root))) return root;
  for (const sub of APP_SUBDIRS) {
    const dir = path.join(root, sub);
    if (isRunnable(readPackage(dir))) return dir;
  }
  return root;
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function isRunnable(pkg) {
  return Boolean(pkg && ((pkg.scripts && pkg.scripts.start) || (typeof pkg.main === 'string' && pkg.main)));
}

// --- Entry point ---

function detectEntry({ appDir, pkg, override, errors, warnings, infos }) {
  const hasBuildScript = Boolean(pkg.scripts && pkg.scripts.build);

  if (override) {
    const resolved = resolveEntryFile(appDir, override);
    if (!resolved && !hasBuildScript) {
      errors.push(`--entry ile verilen dosya bulunamadı: ${override}`);
      return null;
    }
    return finalizeEntry({ kind: 'entry', file: override, command: null }, 'cli', appDir, hasBuildScript, errors, warnings);
  }

  const candidates = [];
  if (pkg.scripts && pkg.scripts.start) {
    candidates.push({ source: 'package.json scripts.start', result: analyzeCommand(pkg.scripts.start, { scripts: pkg.scripts }) });
  }
  if (typeof pkg.main === 'string' && pkg.main) {
    candidates.push({ source: 'package.json main', result: { kind: 'entry', file: pkg.main, command: null } });
  }

  const skipped = [];
  for (const { source, result } of candidates) {
    if (result.kind === 'entry' || result.kind === 'ssr') {
      skipped.forEach(s => infos.push(s));
      return finalizeEntry(result, source, appDir, hasBuildScript, errors, warnings);
    }
    skipped.push(`${source} atlandı: ${result.kind === 'unsupported' ? result.reason : `komut tanınmadı ("${result.command}")`}`);
  }

  const detail = skipped.length ? `\n    ${skipped.join('\n    ')}` : " (package.json'da scripts.start ve main yok)";
  errors.push(`Entry point otomatik tespit edilemedi${detail}\n    → --entry <dosya> ile belirtin`);
  return null;
}

function finalizeEntry(result, source, appDir, hasBuildScript, errors, warnings) {
  if (result.kind === 'ssr') {
    return { kind: 'ssr', framework: result.framework, file: null, source, command: result.command, exists: null };
  }
  const resolved = resolveEntryFile(appDir, result.file);
  const entry = {
    kind: 'entry',
    file: resolved ? toPosix(path.relative(appDir, resolved)) : toPosix(path.normalize(result.file)),
    source,
    command: result.command,
    exists: Boolean(resolved),
    producedByBuild: false
  };
  if (!resolved) {
    if (hasBuildScript) {
      entry.producedByBuild = true;
      warnings.push(`Entry dosyası (${entry.file}) kaynakta yok; "npm run build" çıktısı olduğu varsayılıyor — build sonrası doğrulanacak`);
    } else {
      errors.push(`Entry dosyası bulunamadı: ${entry.file} (kaynak: ${source}) ve package.json'da build script'i yok`);
    }
  }
  return entry;
}

function resolveEntryFile(appDir, file) {
  const base = path.resolve(appDir, file);
  if (!isInside(appDir, base)) return null;
  for (const ext of ENTRY_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// --- Port ---

function detectPort({ webService, appDir, entry, override, errors, warnings }) {
  let port = null;
  const envPort = webService.resolvedEnvironment.PORT;
  const envPortNum = Number(envPort);

  if (override !== undefined && override !== null) {
    port = { value: override, source: 'cli' };
  } else if (envPort && Number.isInteger(envPortNum) && envPortNum > 0 && envPortNum < 65536) {
    port = { value: envPortNum, source: `${webService.envSource || '.env'} PORT` };
  } else {
    const scanned = scanCodeForPort(appDir, entry);
    if (scanned.values.length === 1) {
      port = { value: scanned.values[0], source: `kod (${scanned.files.join(', ')})` };
    } else if (scanned.values.length > 1) {
      errors.push(`Kodda birden fazla PORT varsayılanı bulundu (${scanned.values.join(', ')}); --port ile belirtin`);
      return null;
    }
  }

  if (!port) {
    errors.push("Uygulama portu tespit edilemedi (.env'de PORT yok, kodda process.env.PORT varsayılanı bulunamadı) → --port <n> ile belirtin");
    return null;
  }

  if (envPort && Number(envPort) !== port.value) {
    warnings.push(`.env'de PORT=${envPort} ama uygulama portu ${port.value} (${port.source}) — uygulama PORT değişkenini okuyorsa ${envPort} portunda dinleyecek`);
  }
  return port;
}

const PORT_PATTERNS = [
  /process\.env\.PORT\b[^;\n]{0,40}?(?:\|\||\?\?)\s*['"]?(\d{2,5})\b/g,
  /\{[^}]*\bPORT\s*=\s*['"]?(\d{2,5})\b[^}]*\}\s*=\s*process\.env\b/g
];

function scanCodeForPort(appDir, entry) {
  const files = [];
  if (entry && entry.kind === 'entry' && entry.exists) files.push(path.join(appDir, entry.file));
  const values = new Set();
  const matchedFiles = [];

  const scanFile = file => {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    let found = false;
    for (const re of PORT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content))) {
        values.add(Number(m[1]));
        found = true;
      }
    }
    if (found) matchedFiles.push(toPosix(path.relative(appDir, file)));
  };

  files.forEach(scanFile);
  if (!values.size) walkSourceFiles(appDir).forEach(scanFile);
  return { values: [...values], files: matchedFiles };
}

function walkSourceFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length && result.length < SCAN_MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(dir, e.name));
      } else if (SCAN_EXTENSIONS.has(path.extname(e.name))) {
        result.push(path.join(dir, e.name));
      }
    }
  }
  return result;
}

// --- Node versiyonu ---

function detectNodeVersion(pkg, dirs, warnings) {
  const engines = pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node.trim() : null;
  const pinned = nodeMajorFromVersionFile(dirs);

  if (pinned) {
    if (engines && satisfiesMajor(engines, pinned.major) === false) {
      warnings.push(`${pinned.file} Node ${pinned.major} istiyor ama package.json engines.node "${engines}" — ${pinned.file} esas alındı`);
    }
    return { major: pinned.major, source: pinned.file, engines };
  }
  if (engines) {
    const major = lowestMajor(engines);
    if (major) return { major, source: 'package.json engines.node', engines };
    warnings.push(`package.json engines.node ("${engines}") yorumlanamadı`);
  }
  warnings.push(`Node versiyonu tespit edilemedi; varsayılan Node ${DEFAULT_NODE_MAJOR} kullanılacak`);
  return { major: DEFAULT_NODE_MAJOR, source: 'varsayılan', engines };
}

/** .nvmrc / .node-version içindeki sürümün major'ı (`v20.11.1` → 20; `lts/*` gibi takma adlar yok sayılır). */
function nodeMajorFromVersionFile(dirs) {
  for (const dir of [...new Set(dirs)]) {
    for (const file of ['.nvmrc', '.node-version']) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const m = /^\s*v?(\d+)/.exec(text);
      if (m) return { major: Number(m[1]), file };
    }
  }
  return null;
}

/** engines aralığının izin verdiği en düşük major (`>=18` → 18, `^20.10` → 20, `18 || 20` → 18). */
function lowestMajor(range) {
  const majors = range
    .split('||')
    .map(part => /\d+/.exec(part))
    .filter(Boolean)
    .map(m => Number(m[0]));
  return majors.length ? Math.min(...majors) : null;
}

/**
 * Sadece major seviyesinde yaklaşık semver kontrolü. Yorumlanamazsa null döner (uyarı üretilmez).
 */
function satisfiesMajor(range, major) {
  const sets = range.split('||').map(s => s.trim()).filter(Boolean);
  if (!sets.length) return null;
  let understood = false;
  for (const set of sets) {
    const comparators = set.split(/\s+/).filter(Boolean);
    let ok = true;
    for (const c of comparators) {
      const m = /^(>=|<=|>|<|\^|~|=)?v?(\d+|x|\*)(?:\.[\dx*]+)*$/.exec(c);
      if (!m) return null;
      understood = true;
      if (m[2] === 'x' || m[2] === '*') continue;
      const n = Number(m[2]);
      const op = m[1] || '=';
      if (op === '>=' && !(major >= n)) ok = false;
      if (op === '>' && !(major > n || (major === n && /\.\d/.test(c)))) ok = false;
      if (op === '<=' && !(major <= n)) ok = false;
      if (op === '<' && !(major < n)) ok = false;
      if ((op === '^' || op === '~' || op === '=') && major !== n) ok = false;
    }
    if (ok) return true;
  }
  return understood ? false : null;
}

// --- Framework ---

function detectFramework(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const runtimeDeps = pkg.dependencies || {};
  const ssrKey = Object.keys(SSR_DEPENDENCIES).find(d => deps[d]);
  const serverKey = Object.keys(SERVER_DEPENDENCIES).find(d => runtimeDeps[d]);
  return {
    ssr: ssrKey ? SSR_DEPENDENCIES[ssrKey] : null,
    server: serverKey ? SERVER_DEPENDENCIES[serverKey] : null
  };
}

function displayPath(rootDir, p) {
  return rootDir ? toPosix(path.relative(rootDir, p)) : p;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

module.exports = { detectStack, resolveAppDir, satisfiesMajor, lowestMajor, DEFAULT_NODE_MAJOR };
