const path = require('path');
const chalk = require('chalk');
const { maskSecrets } = require('../parser/hostRemap');

/** Temp workspace yolları build sonunda silindiği için proje köküne göre gösterilir. */
function rel(projectDir, p) {
  return path.relative(projectDir, p) || '.';
}

function section(log, title) {
  log('');
  log(chalk.bold.underline(title));
}

/** Kaynak + proje modeli (package.json, .env, tespit edilen veritabanları). */
function printProjectSummary(result, { origin } = {}, log = console.log) {
  const { projectDir, appDir, dependencyServices, report } = result;

  section(log, 'Proje');
  log(`  kaynak:        ${origin || '-'}`);
  log(`  uygulama:      ${rel(projectDir, appDir)}`);
  log(`  ortam:         ${report.envFiles.join(', ') || chalk.gray('.env yok')}`);
  const dbs = dependencyServices.map(s => `${chalk.cyan(s.dbType)} ${chalk.gray(`(${s.image}; bağlantı: ${s.connection.source})`)}`);
  log(`  veritabanları: ${dbs.join(', ') || '-'}`);

  if (report.remaps.length) {
    log('');
    log(chalk.bold('  Bağlantı değişkenleri (gömülü DB\'ye yönlendirildi):'));
    console.table(report.remaps.map(r => ({ db: r.service, değişken: r.key, önce: r.before, sonra: r.after })));
  }
}

/** stackDetector sonucu. */
function printStackSummary(stack, log = console.log) {
  section(log, 'Uygulama');
  if (!stack.packageJson) {
    log(chalk.red('  Node.js projesi tespit edilemedi'));
    return;
  }
  log(`  paket:         ${stack.packageJson.name || '(isimsiz)'}${stack.packageJson.version ? `@${stack.packageJson.version}` : ''}`);

  const { entry } = stack;
  if (!entry) {
    log(`  entry:         ${chalk.red('tespit edilemedi')}`);
  } else if (entry.kind === 'ssr') {
    log(`  entry:         ${chalk.magenta(`SSR (${entry.framework})`)}  ${chalk.gray(`← ${entry.source}: ${entry.command}`)}`);
  } else {
    const flag = entry.exists ? '' : chalk.yellow(entry.producedByBuild ? ' (build çıktısı)' : ' (bulunamadı)');
    log(`  entry:         ${entry.file}${flag}  ${chalk.gray(`← ${entry.source}${entry.command ? `: ${entry.command}` : ''}`)}`);
  }

  log(`  port:          ${stack.port ? `${stack.port.value}  ${chalk.gray(`← ${stack.port.source}`)}` : chalk.red('tespit edilemedi')}`);
  if (stack.node) {
    log(`  node:          ${stack.node.major}  ${chalk.gray(`← ${stack.node.source}${stack.node.engines ? ` (engines: ${stack.node.engines})` : ''}`)}`);
  }
  const fw = [stack.framework.server, stack.framework.ssr && `${stack.framework.ssr} (SSR)`].filter(Boolean);
  log(`  framework:     ${fw.join(', ') || '-'}`);
}

const STATUS_LABEL = {
  ok: () => chalk.green('✔ uyumlu'),
  experimental: () => chalk.yellow('⚠ deneysel'),
  error: () => chalk.red('✖ hata'),
  external: () => chalk.cyan('↗ harici')
};

/** versionResolver sonucu. */
function printPreflight(versions, log = console.log) {
  section(log, `DB pre-flight (${versions.services.length} servis)`);
  if (!versions.services.length) {
    log('  DB servisi yok');
    return;
  }
  for (const s of versions.services) {
    const major = s.status === 'external' ? chalk.gray(`(${s.engine}, hedef makinede kurulu)`) : s.series !== null ? `v${s.series} ${chalk.gray(`(${s.seriesSource}${s.manifestEntry ? `, ${s.manifestEntry.version}` : ''})`)}` : chalk.gray('v?');
    log(`  ${STATUS_LABEL[s.status]()}  ${chalk.cyan(s.service.padEnd(12))} ${s.dbType.padEnd(8)} ${String(s.image).padEnd(28)} ${major}`);
  }
}

/** Tüm aşamalardan toplanan hata/uyarı/bilgi listesi. */
function printFindings({ errors, warnings, infos }, log = console.log) {
  if (infos.length) {
    section(log, 'Bilgi');
    infos.forEach(i => log(chalk.gray(`  • ${i}`)));
  }
  if (warnings.length) {
    section(log, `Uyarılar (${warnings.length})`);
    warnings.forEach(w => log(chalk.yellow(`  ⚠ ${w}`)));
  }
  if (errors.length) {
    section(log, `Hatalar (${errors.length})`);
    errors.forEach(e => log(chalk.red(`  ✖ ${e}`)));
  }
  log('');
}

/** `--json` çıktısı için şifreleri maskelenmiş kopya. */
function toPublicJson(result) {
  const SECRET_KEY = /PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|PRIVATE/i;
  const maskEnv = env => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_KEY.test(k) && v ? '****' : maskSecrets(v)]));
  const maskService = s => s && { ...s, environment: maskEnv(s.environment), resolvedEnvironment: maskEnv(s.resolvedEnvironment) };
  const maskDb = s => ({
    ...maskService(s),
    resolvedEnvironment: undefined,
    command: s.command ? s.command.map((a, i) => (s.command[i - 1] === '--requirepass' ? '****' : a)) : null
  });
  const maskWeb = s => ({
    ...maskService(s),
    remaps: s.remaps.map(r => ({ ...r, before: maskSecrets(r.before), after: maskSecrets(r.after) }))
  });
  return {
    projectDir: result.projectDir,
    appDir: result.appDir,
    webService: maskWeb(result.webService),
    dependencyServices: result.dependencyServices.map(maskDb),
    report: result.report
  };
}

module.exports = { printProjectSummary, printStackSummary, printPreflight, printFindings, toPublicJson };
