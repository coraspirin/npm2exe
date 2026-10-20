const fs = require('fs');
const path = require('path');
const { parseDotenv } = require('./envLoader');
const { interpolateString } = require('./interpolate');
const { splitUrlRest, maskSecrets, LOOPBACK } = require('./hostRemap');
const { detectDatabases, DB_TYPES } = require('../detector/dbDetector');
const { resolveAppDir } = require('../detector/stackDetector');

/**
 * Docker'sız bir Node.js projesinden (package.json + .env) build zincirinin beklediği proje modelini üretir:
 * { projectDir, webService, buildServices, dependencyServices, otherServices, report }.
 *
 * - Veritabanları package.json'daki sürücülerden (pg, mysql2, mongoose, ioredis ...) tespit edilir.
 * - Bağlantı bilgisi (kullanıcı, şifre, DB adı, port) .env'den okunur; gömülen DB bu bilgilerle kurulur.
 * - .env'deki localhost adresleri 127.0.0.1'e çevrilir ve launcher'ın port taşıma yeniden yazımı için kaydedilir.
 * - .env'de bilgi yoksa: kod process.env.DATABASE_URL gibi değişkenler okuyorsa bunlar üretilir; okumuyorsa
 *   DB varsayılan portta, kodda yazılı bağlantıya uygun (kimlik doğrulamasız) çalışır.
 */

const ENV_FILES = ['.env'];
const ENV_FALLBACK_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, mongo: 27017, redis: 6379 };
const SQL_TYPES = ['postgres', 'mysql', 'mariadb'];
// Launcher bunu kurulum başına üretilen şifreyle değiştirir (runtime/launcher.js SECRET_PLACEHOLDER)
const SECRET_PLACEHOLDER = '${D2E_DB_SECRET}';

const SCHEME_FAMILY = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  mongodb: 'mongo',
  'mongodb+srv': 'mongo',
  redis: 'redis',
  rediss: 'redis'
};
const URL_SCHEME_FOR = { postgres: 'postgresql', mysql: 'mysql', mariadb: 'mysql', mongo: 'mongodb', redis: 'redis' };

// Ayrık bağlantı değişkenleri: <ÖNEK>_<ALAN> (PGHOST gibi alt çizgisiz biçimler dahil)
const PREFIX_FAMILY = {
  PG: 'postgres', POSTGRES: 'postgres', POSTGRESQL: 'postgres',
  MYSQL: 'mysql', MARIADB: 'mysql',
  MONGO: 'mongo', MONGODB: 'mongo',
  REDIS: 'redis',
  DB: 'generic', DATABASE: 'generic', SQL: 'generic', TYPEORM: 'generic'
};
const FIELD_ALIASES = {
  HOST: 'host', HOSTNAME: 'host', SERVER: 'host', ADDR: 'host', ADDRESS: 'host',
  PORT: 'port',
  USER: 'user', USERNAME: 'user',
  PASSWORD: 'password', PASS: 'password', PWD: 'password',
  NAME: 'database', DATABASE: 'database', DB: 'database', DBNAME: 'database'
};
const DISCRETE_RE = new RegExp(
  `^(${Object.keys(PREFIX_FAMILY).join('|')})_?(${Object.keys(FIELD_ALIASES).join('|')})$`,
  'i'
);
const URL_KEY_RE = /(?:URL|URI|DSN|CONNECTION_STRING|CONN_STR|CONNECTION)$/i;
const VERSION_KEYS = {
  postgres: ['POSTGRES_VERSION', 'PG_VERSION', 'POSTGRESQL_VERSION'],
  mysql: ['MYSQL_VERSION'],
  mariadb: ['MARIADB_VERSION'],
  mongo: ['MONGO_VERSION', 'MONGODB_VERSION'],
  redis: ['REDIS_VERSION']
};
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);

const SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']);
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', 'public', 'test', 'tests', '__tests__']);
const SCAN_MAX_FILES = 800;

const INIT_DIRS = ['init', 'initdb', 'docker-entrypoint-initdb.d', 'db/init', 'database/init', 'sql/init'];
const INIT_FILE_DIRS = ['.', 'db', 'sql', 'database'];
const INIT_FILE_RE = /^(\d+[-_.]?)?(init|schema|setup|seed|create|structure|dump)[^/]*\.sql$/i;

class ProjectError extends Error {}

/**
 * @param {string} projectDir
 * @param {{ manifest: object, overrides?: {byService, byType}, db?: string[]|null, appName?: string }} options
 *   db: tespiti geçersiz kılan DB tipleri listesi (['none'] → hiç DB gömülmez)
 */
function buildProjectModel(projectDir, options = {}) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new ProjectError(`Proje klasörü bulunamadı: ${projectDir}`);
  }
  const manifest = options.manifest || {};
  const overrides = options.overrides || { byService: {}, byType: {} };
  const warnings = [];
  const infos = [];

  const appDir = resolveAppDir(projectDir);
  const dirs = [projectDir, appDir];
  const { env: rawEnv, files: envFiles, fallback } = loadProjectEnv(dirs, warnings);
  if (fallback) {
    warnings.push(`.env yok; değerler ${envFiles.join(', ')} dosyasından alındı — örnek değerler gerçek ortamınızla aynı değilse .env oluşturun`);
  }
  const env = expandEnv(rawEnv);

  // ------------------------------------------------------------ DB tipleri
  const detected = detectDatabases(dirs);
  let types = detected.types.map(t => t.type);
  const via = Object.fromEntries(detected.types.map(t => [t.type, t.via]));
  if (options.db && options.db.length) {
    const forced = normalizeDbList(options.db);
    const extra = forced.filter(t => !types.includes(t));
    const dropped = types.filter(t => !forced.includes(t));
    if (extra.length) infos.push(`--db ile eklendi: ${extra.join(', ')}`);
    if (dropped.length) infos.push(`--db ile çıkarıldı: ${dropped.join(', ')}`);
    types = forced;
    for (const t of forced) via[t] = via[t] || ['--db'];
  }
  if (detected.sqlite.length) infos.push(`SQLite kullanılıyor (${detected.sqlite.join(', ')}): ayrı sunucu gerekmez, veritabanı dosyası uygulamayla birlikte taşınır`);
  if (detected.cloud.length) infos.push(`Bulut veritabanı istemcileri (${detected.cloud.join(', ')}) gömülmez; uygulama internetteki sunucuya bağlanır`);

  // ------------------------------------------------------------ .env'deki bağlantılar
  const refs = collectConnectionRefs(env);
  assignGenericRefs(refs, types, env, warnings);

  const codeScan = scanCode(appDir);
  const dbNameDefault = defaultDbName(options.appName || readPackageName(appDir) || readPackageName(projectDir) || path.basename(projectDir));
  const resolvedEnv = { ...env };
  const changes = [];
  const services = [];

  for (const type of types) {
    const family = familyOf(type);
    const familyRefs = refs.filter(r => r.family === family);
    const primary = pickPrimary(familyRefs);
    const forced = Boolean(options.db && options.db.length);

    if (primary && primary.remote && !forced) {
      infos.push(`${type}: .env uzak bir sunucuyu gösteriyor (${primary.key} → ${primary.hosts.map(h => h.host).join(',')}); pakete gömülmedi, uygulama o sunucuya bağlanacak — gömmek için --db ${type}`);
      continue;
    }

    let conn = primary ? mergeConnection(familyRefs, primary) : null;
    let source = conn ? `.env (${[...new Set(familyRefs.map(r => r.key))].join(', ')})` : null;
    let generated = [];

    if (!conn) {
      // .env'de bağlantı yok: kodun okuduğu değişkenler üretilir (port taşınırsa güncellenebilsin diye); koddaki
      // yazılı adres (örn. `process.env.MONGODB_URI || 'mongodb://localhost/notes'`) bağlantı bilgisini verir.
      const literal = codeScan.urls.find(u => u.family === family && !u.remote);
      const keys = codeScan.envKeys.filter(k => classifyKey(k, family, types));
      conn = literal
        ? { port: literal.port, user: literal.user, password: literal.password, database: literal.database }
        : { port: DEFAULT_PORTS[type], user: null, password: null, database: null };
      if (keys.length) {
        if (!literal && family !== 'redis') conn.database = dbNameDefault;
        // Değişkenleri biz ürettiğimiz için şifreyi de uygulamaya iletebiliriz: şifresiz/trust mod yerine rastgele şifre
        // (gömülü DB 127.0.0.1'de dinler ama aynı makinedeki diğer kullanıcılar da erişebilir).
        // Şifre ancak kodun okuduğu bir URL veya şifre değişkeniyle uygulamaya ulaşabilir.
        const carriesPassword = keys.some(k => URL_KEY_RE.test(k)) || (family !== 'mongo' && keys.some(k => fieldOf(k) === 'password'));
        if (!conn.password && carriesPassword) {
          // Gerçek şifre hedef makinede ilk çalıştırmada üretilir (runtime/launcher.js dbSecret); pakete sadece yer tutucu girer.
          conn.password = SECRET_PLACEHOLDER;
          if (family === 'mongo' && !conn.user) conn.user = 'app';
        }
        generated = keys;
        source = `üretildi (${keys.join(', ')})${literal ? `, bilgiler koddan (${literal.file})` : ''}`;
      } else if (literal) {
        source = `kod (${literal.file})`;
        infos.push(`${type}: bağlantı bilgisi koddaki adresten alındı (${literal.file}: ${maskSecrets(literal.raw)}); port ${literal.port || DEFAULT_PORTS[type]} doluysa uygulama bağlanamaz — adresi bir ortam değişkeninden okumanız önerilir`);
      } else {
        source = 'varsayılan';
        warnings.push(`${type}: .env'de ve kodda bağlantı bilgisi bulunamadı; DB varsayılan portta (${conn.port}) kimlik doğrulamasız çalışacak — bu bilgisayardaki diğer kullanıcılar da erişebilir. Bağlantıyı .env'de (şifreyle) tanımlamanız önerilir`);
      }
    }
    if (!conn.port) conn.port = DEFAULT_PORTS[type];
    if (family === 'mysql' && !conn.password && (conn.user || 'root') === 'root') {
      conn.password = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || null;
    }
    applyDefaults(type, conn);

    const name = type;
    // .env'deki referansları 127.0.0.1'e çevir, launcher port taşırsa güncellensin
    for (const ref of familyRefs) {
      if (ref.remote && !forced) continue;
      const after = rewriteRef(ref, resolvedEnv[ref.key], conn, type, infos);
      const port = ref.kind === 'url' ? (ref.hosts[0] && ref.hosts[0].port) || null : null;
      if (after !== resolvedEnv[ref.key]) {
        changes.push({ key: ref.key, before: resolvedEnv[ref.key], after, kind: ref.kind, targets: [{ service: name, port }] });
        resolvedEnv[ref.key] = after;
      } else if (ref.kind) {
        changes.push({ key: ref.key, before: after, after, kind: ref.kind, targets: [{ service: name, port }] });
      }
    }
    for (const key of generated) {
      const value = generatedValue(key, family, types, conn, type);
      if (value === null) continue;
      resolvedEnv[key] = value;
      const kind = URL_KEY_RE.test(key) ? 'url' : fieldOf(key) === 'host' ? 'host' : null;
      changes.push({ key, before: null, after: value, kind, targets: kind ? [{ service: name, port: kind === 'url' ? conn.port : null }] : [] });
    }
    if (generated.length) {
      infos.push(`${type}: .env'de bağlantı yok; kodun okuduğu değişkenler üretildi: ${generated.map(k => `${k}=${maskSecrets(resolvedEnv[k])}`).join(', ')}`);
    }

    const versionKey = (VERSION_KEYS[type] || []).find(k => env[k]);
    const hasOverride = overrides.byService[name] !== undefined || overrides.byType[type] !== undefined;
    let imageTag = null;
    let versionSource = null;
    if (versionKey) {
      imageTag = String(env[versionKey]);
      versionSource = `.env ${versionKey}`;
    } else if (!hasOverride) {
      imageTag = latestTestedSeries(manifest[type]);
      versionSource = 'varsayılan (en yeni test edilmiş)';
    }

    const imageEnv = imageEnvironment(type, conn);
    const initFiles = SQL_TYPES.includes(type) ? findInitScripts(dirs) : [];
    if (initFiles.length) infos.push(`${type}: ilk kurulumda çalıştırılacak SQL dosyaları: ${initFiles.map(f => path.relative(projectDir, f).split(path.sep).join('/')).join(', ')}`);

    services.push({
      name,
      image: (via[type] || []).join(', '),
      dbType: type,
      imageTag,
      versionSource,
      build: null,
      ports: [],
      expose: [conn.port],
      environment: imageEnv,
      resolvedEnvironment: imageEnv,
      remaps: [],
      volumes: [],
      initFiles,
      command: type === 'redis' && conn.password ? ['--requirepass', conn.password] : null,
      dependsOn: [],
      dependsOnDetail: [],
      isDatabase: true,
      connection: { source, port: conn.port, user: conn.user, database: conn.database, password: conn.password ? '****' : null }
    });
  }

  if (!resolvedEnv.NODE_ENV) {
    resolvedEnv.NODE_ENV = 'production';
    infos.push('NODE_ENV tanımlı değil; production olarak ayarlandı');
  }

  const webService = {
    name: 'app',
    image: null,
    dbType: null,
    imageTag: null,
    build: { context: projectDir, dockerfile: null },
    ports: [],
    expose: [],
    environment: env,
    resolvedEnvironment: resolvedEnv,
    remaps: changes,
    envSource: envFiles.length ? envFiles[envFiles.length - 1] : '.env',
    volumes: [],
    command: null,
    dependsOn: services.map(s => s.name),
    dependsOnDetail: services.map(s => ({ service: s.name, condition: 'service_started' })),
    isDatabase: false
  };

  return {
    projectDir,
    appDir,
    webService,
    buildServices: [webService],
    dependencyServices: services,
    otherServices: [],
    raw: [webService, ...services],
    report: {
      envFiles,
      detected: detected.types,
      sqlite: detected.sqlite,
      prisma: detected.prisma,
      remaps: changes.filter(c => c.before !== c.after).map(c => ({ service: c.targets[0] ? c.targets[0].service : '-', key: c.key, before: c.before === null ? '(yok)' : maskSecrets(c.before), after: maskSecrets(c.after) })),
      warnings,
      infos
    }
  };
}

// ---------------------------------------------------------------- .env

/** Kök ve uygulama klasöründeki .env (yoksa .env.example) birleştirilir; uygulama klasörü önceliklidir. */
function loadProjectEnv(dirs, warnings) {
  const unique = [...new Set(dirs.map(d => path.resolve(d)))];
  const root = unique[0];
  const pick = names => {
    const found = [];
    for (const dir of unique) {
      for (const name of names) {
        const file = path.join(dir, name);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          found.push(file);
          break;
        }
      }
    }
    return found;
  };
  let files = pick(ENV_FILES);
  let fallback = false;
  if (!files.length) {
    files = pick(ENV_FALLBACK_FILES);
    fallback = files.length > 0;
  }
  const env = {};
  for (const file of files) {
    try {
      Object.assign(env, parseDotenv(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      warnings.push(`${path.relative(root, file)} okunamadı: ${err.message}`);
    }
  }
  return { env, files: files.map(f => path.relative(root, f).split(path.sep).join('/')), fallback };
}

/** dotenv-expand benzeri: değerlerdeki ${VAR} referansları aynı dosyadaki değerlerle genişletilir. */
function expandEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || !v.includes('$')) {
      out[k] = v;
      continue;
    }
    try {
      out[k] = interpolateString(v, { ...env, ...out });
    } catch {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- bağlantı referansları

function familyOf(type) {
  return type === 'mariadb' ? 'mysql' : type;
}

function normalizeDbList(list) {
  const aliases = { pg: 'postgres', postgresql: 'postgres', mongodb: 'mongo', maria: 'mariadb' };
  const out = [];
  for (const raw of list.flatMap(v => String(v).split(/[\s,;]+/)).filter(Boolean)) {
    const t = aliases[raw.toLowerCase()] || raw.toLowerCase();
    if (t === 'none' || t === 'yok') return [];
    if (!DB_TYPES.includes(t)) throw new ProjectError(`--db: bilinmeyen veritabanı "${raw}" (geçerli: ${DB_TYPES.join(', ')}, none)`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  if (LOCAL_HOSTS.has(h)) return true;
  // Tek etiketli isimler (db, postgres, mongo): Docker Compose servis adı — bu makinede yerel servis demektir
  return /^[a-z0-9_-]+$/.test(h) && !/^\d+$/.test(h);
}

function parseHostList(hostPart) {
  return hostPart.split(',').filter(Boolean).map(entry => {
    const e = entry.trim();
    if (e.startsWith('[')) {
      const end = e.indexOf(']');
      const port = /^:(\d+)$/.exec(e.slice(end + 1));
      return { host: e.slice(0, end + 1), port: port ? Number(port[1]) : null };
    }
    const colon = e.lastIndexOf(':');
    if (colon === -1) return { host: e, port: null };
    const port = Number(e.slice(colon + 1));
    return { host: e.slice(0, colon), port: Number.isInteger(port) ? port : null };
  });
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** scheme://user:pass@host:port/db?params → parçalar (aile bilinmiyorsa null). */
function parseConnectionUrl(value) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(String(value).trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const family = SCHEME_FAMILY[scheme];
  if (!family) return null;
  const { userinfo, hostPart, tail } = splitUrlRest(m[2]);
  const colon = userinfo.indexOf(':');
  const user = userinfo ? safeDecode(colon === -1 ? userinfo : userinfo.slice(0, colon)) : null;
  const password = colon === -1 ? null : safeDecode(userinfo.slice(colon + 1));
  const pathMatch = /^\/([^?#]*)/.exec(tail);
  const dbPath = pathMatch ? safeDecode(pathMatch[1]) : '';
  const hosts = parseHostList(hostPart);
  return {
    scheme,
    family,
    user: user || null,
    password: password || null,
    database: family === 'redis' ? null : dbPath || null,
    hosts,
    port: hosts[0] ? hosts[0].port : null,
    query: (/\?([^#]*)/.exec(tail) || [])[1] || '',
    srv: scheme === 'mongodb+srv'
  };
}

/** .env'deki tüm DB bağlantı referansları: URL'ler ve ayrık *_HOST/*_PORT/... değişkenleri. */
function collectConnectionRefs(env) {
  const refs = [];
  const discrete = new Map(); // `${prefix}` → ref
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value) continue;
    const url = parseConnectionUrl(value);
    if (url) {
      refs.push({
        key,
        kind: 'url',
        family: url.family,
        scheme: url.scheme,
        hosts: url.hosts,
        port: url.port,
        user: url.user,
        password: url.password,
        database: url.database,
        query: url.query,
        remote: url.srv || !url.hosts.every(h => isLocalHost(h.host)),
        priority: keyPriority(key)
      });
      continue;
    }
    const m = DISCRETE_RE.exec(key);
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    const field = FIELD_ALIASES[m[2].toUpperCase()];
    const family = PREFIX_FAMILY[prefix];
    if (family === 'redis' && field === 'database') continue; // REDIS_DB: indeks numarası
    if (!discrete.has(prefix)) {
      discrete.set(prefix, { key: null, kind: null, family, prefix, fields: {}, keys: {}, hosts: [], remote: false, priority: keyPriority(prefix) + 1 });
    }
    const ref = discrete.get(prefix);
    ref.fields[field] = value;
    ref.keys[field] = key;
  }
  for (const ref of discrete.values()) {
    const f = ref.fields;
    if (!f.host && !f.port && !f.user && !f.password && !f.database) continue;
    ref.port = f.port && /^\d+$/.test(f.port) ? Number(f.port) : null;
    ref.user = f.user || null;
    ref.password = f.password || null;
    ref.database = f.database || null;
    if (f.host) {
      ref.hosts = parseHostList(f.host).map(h => ({ host: h.host, port: h.port }));
      ref.remote = !ref.hosts.every(h => isLocalHost(h.host));
      ref.key = ref.keys.host;
      ref.kind = 'host';
    } else {
      ref.key = ref.keys.port || ref.keys.user || ref.keys.password || ref.keys.database;
    }
    refs.push(ref);
  }
  return refs;
}

/** TEST_/SHADOW_ önekli bağlantılar ana bağlantı olarak seçilmez. */
function keyPriority(key) {
  return /TEST|SHADOW|E2E|CI_/i.test(key) ? 10 : 0;
}

/** DB_HOST / DATABASE_URL gibi genel anahtarları tek bir aileye bağlar. */
function assignGenericRefs(refs, types, env, warnings) {
  const families = [...new Set(types.map(familyOf))];
  const sql = families.filter(f => f === 'postgres' || f === 'mysql');
  for (const ref of refs.filter(r => r.family === 'generic')) {
    const hint = String(env.DB_DIALECT || env.DB_CLIENT || env.DB_CONNECTION || env.DB_TYPE || env.DB_DRIVER || env.DATABASE_TYPE || env.TYPEORM_CONNECTION || '').toLowerCase();
    let family = null;
    if (/pg|postg/.test(hint)) family = 'postgres';
    else if (/mysql|maria/.test(hint)) family = 'mysql';
    else if (/mongo/.test(hint)) family = 'mongo';
    else if (sql.length === 1) family = sql[0];
    else if (sql.length > 1) {
      family = ref.port === DEFAULT_PORTS.mysql ? 'mysql' : ref.port === DEFAULT_PORTS.postgres ? 'postgres' : sql[0];
      warnings.push(`${ref.prefix}_* değişkenleri hem postgres hem mysql olabilir; ${family} kabul edildi (DB_DIALECT ile belirtebilirsiniz)`);
    } else if (families.includes('mongo')) family = 'mongo';
    ref.family = family || 'unknown';
  }
}

function pickPrimary(refs) {
  if (!refs.length) return null;
  return [...refs].sort((a, b) => a.priority - b.priority || (a.kind === 'url' ? -1 : 0) - (b.kind === 'url' ? -1 : 0))[0];
}

/** Ana referans esas alınır; eksik alanlar aynı ailenin diğer referanslarından tamamlanır. */
function mergeConnection(refs, primary) {
  const conn = { port: primary.port, user: primary.user, password: primary.password, database: primary.database };
  for (const r of refs) {
    if (r.priority > primary.priority) continue;
    for (const k of ['port', 'user', 'password', 'database']) if (!conn[k] && r[k]) conn[k] = r[k];
  }
  return conn;
}

function applyDefaults(type, conn) {
  if (type === 'postgres' && !conn.user) conn.user = 'postgres';
  if ((type === 'mysql' || type === 'mariadb') && !conn.user) conn.user = 'root';
}

/** .env değerini 127.0.0.1'e çevirir (URL'de host listesi, ayrık değişkende host). */
function rewriteRef(ref, value, conn, type, infos) {
  if (typeof value !== 'string') return value;
  if (ref.kind === 'url') {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(value);
    const { userinfo, hostPart, tail } = splitUrlRest(m[2]);
    const hosts = parseHostList(hostPart);
    const newHosts = hosts.map(h => `${LOOPBACK}${h.port ? `:${h.port}` : ''}`);
    let newTail = tail;
    // MongoDB root kullanıcısı admin DB'sinde oluşur; authSource yoksa DB adındaki kullanıcı aranır ve giriş başarısız olur
    if (type === 'mongo' && conn.user && ref.user && !/(^|[?&])authSource=/i.test(tail)) {
      newTail = tail.includes('?') ? tail.replace('?', '?authSource=admin&') : `${tail || '/'}?authSource=admin`;
      infos.push(`${ref.key}: authSource=admin eklendi (gömülü MongoDB'de kullanıcı admin veritabanında oluşturulur)`);
    }
    const scheme = m[1].toLowerCase() === 'mongodb+srv' ? 'mongodb' : m[1];
    return `${scheme}://${userinfo ? `${userinfo}@` : ''}${[...new Set(newHosts)].join(',')}${newTail}`;
  }
  if (ref.kind === 'host') return LOOPBACK;
  return value;
}

// ---------------------------------------------------------------- kod taraması

/** Kaynak kodda okunan process.env anahtarları ve yazılı bağlantı adresleri. */
function scanCode(appDir) {
  const envKeys = new Set();
  const urls = [];
  const ENV_RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
  const DESTRUCT_RE = /\{([^{}]*)\}\s*=\s*process\.env\b/g;
  const URL_RE = /(['"`])((?:postgres|postgresql|mysql|mariadb|mongodb|redis|rediss):\/\/[^'"`\s$]+)\1/g;
  for (const file of walkSourceFiles(appDir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let m;
    ENV_RE.lastIndex = 0;
    while ((m = ENV_RE.exec(text))) envKeys.add(m[1] || m[2]);
    DESTRUCT_RE.lastIndex = 0;
    while ((m = DESTRUCT_RE.exec(text))) {
      for (const part of m[1].split(',')) {
        const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part);
        if (name) envKeys.add(name[1]);
      }
    }
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      const url = parseConnectionUrl(m[2]);
      if (!url) continue;
      urls.push({ ...url, raw: m[2], remote: url.srv || !url.hosts.every(h => isLocalHost(h.host)), file: path.relative(appDir, file).split(path.sep).join('/') });
    }
  }
  return { envKeys: [...envKeys].sort(), urls };
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
      } else if (SCAN_EXTENSIONS.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
        result.push(path.join(dir, e.name));
      }
    }
  }
  return result;
}

function fieldOf(key) {
  const m = DISCRETE_RE.exec(key);
  return m ? FIELD_ALIASES[m[2].toUpperCase()] : null;
}

/** Koddaki bir env anahtarı bu DB ailesinin bağlantı bilgisi mi? */
function classifyKey(key, family, types) {
  const upper = key.toUpperCase();
  const familyToken = { postgres: /PG|POSTGRES/, mysql: /MYSQL|MARIA/, mongo: /MONGO/, redis: /REDIS/ }[family];
  const otherToken = /PG|POSTGRES|MYSQL|MARIA|MONGO|REDIS/;
  const generic = /^(DATABASE|DB)(_|$)/;
  if (URL_KEY_RE.test(upper)) {
    if (familyToken.test(upper)) return true;
    if (otherToken.test(upper) || !generic.test(upper)) return false;
    return genericFamily(types) === family;
  }
  const m = DISCRETE_RE.exec(upper);
  if (!m) return false;
  const fam = PREFIX_FAMILY[m[1].toUpperCase()];
  if (fam === 'generic') return genericFamily(types) === family && !(family === 'redis');
  if (family === 'redis' && FIELD_ALIASES[m[2].toUpperCase()] === 'database') return false;
  return fam === family;
}

/** DATABASE_URL / DB_HOST gibi genel anahtarların ait olduğu aile: önce SQL, yoksa MongoDB. */
function genericFamily(types) {
  const fams = types.map(familyOf);
  return fams.find(f => f === 'postgres' || f === 'mysql') || (fams.includes('mongo') ? 'mongo' : null);
}

function generatedValue(key, family, types, conn, type) {
  if (URL_KEY_RE.test(key)) return buildUrl(type, conn);
  const field = fieldOf(key);
  if (field === 'host') return LOOPBACK;
  if (field === 'port') return String(conn.port);
  if (field === 'user') return conn.user || null;
  if (field === 'password') return conn.password || '';
  if (field === 'database') return conn.database || null;
  return null;
}

function buildUrl(type, conn) {
  const scheme = URL_SCHEME_FOR[type];
  // Yer tutucu encode edilmez; launcher'ın ürettiği şifre base64url olduğu için URL'de güvenlidir
  const enc = s => (s === SECRET_PLACEHOLDER ? s : encodeURIComponent(s));
  const auth = conn.user ? `${enc(conn.user)}${conn.password ? `:${enc(conn.password)}` : ''}@` : conn.password ? `:${enc(conn.password)}@` : '';
  const db = conn.database ? `/${encodeURIComponent(conn.database)}` : '';
  const query = type === 'mongo' && conn.user ? `${db ? '' : '/'}?authSource=admin` : '';
  return `${scheme}://${auth}${LOOPBACK}:${conn.port}${db}${query}`;
}

// ---------------------------------------------------------------- DB servis ortamı

/** Gömülü DB'nin ilk kurulum ortamı (resmi Docker imajlarının değişken adlarıyla; runtime/lib/engines.js bunları okur). */
function imageEnvironment(type, conn) {
  const env = {};
  if (type === 'postgres') {
    env.POSTGRES_USER = conn.user || 'postgres';
    if (conn.password) env.POSTGRES_PASSWORD = conn.password;
    else env.POSTGRES_HOST_AUTH_METHOD = 'trust';
    if (conn.database) env.POSTGRES_DB = conn.database;
  } else if (type === 'mysql' || type === 'mariadb') {
    const user = conn.user || 'root';
    if (user === 'root') {
      if (conn.password) env.MYSQL_ROOT_PASSWORD = conn.password;
      else env.MYSQL_ALLOW_EMPTY_PASSWORD = 'yes';
    } else {
      env.MYSQL_USER = user;
      env.MYSQL_PASSWORD = conn.password || '';
      if (conn.password) env.MYSQL_ROOT_PASSWORD = conn.password;
      else env.MYSQL_ALLOW_EMPTY_PASSWORD = 'yes';
    }
    if (conn.database) env.MYSQL_DATABASE = conn.database;
  } else if (type === 'mongo') {
    if (conn.user) {
      env.MONGO_INITDB_ROOT_USERNAME = conn.user;
      env.MONGO_INITDB_ROOT_PASSWORD = conn.password || '';
    }
    if (conn.database) env.MONGO_INITDB_DATABASE = conn.database;
  }
  return env;
}

/** Manifest'te desteklenen ve test edilmiş en yeni seri. */
function latestTestedSeries(def) {
  if (!def) return null;
  const candidates = (def.supported_majors || [])
    .map(String)
    .filter(s => def.versions && def.versions[s] && def.versions[s].tested !== false);
  const list = candidates.length ? candidates : (def.supported_majors || []).map(String);
  const num = s => s.split('.').map(Number);
  list.sort((a, b) => {
    const [a1, a2 = 0] = num(a);
    const [b1, b2 = 0] = num(b);
    return a1 - b1 || a2 - b2;
  });
  return list.length ? list[list.length - 1] : null;
}

/** İlk kurulumda çalıştırılacak .sql dosyaları: init klasörlerindeki tümü + init/schema/seed adlı dosyalar. */
function findInitScripts(dirs) {
  const files = [];
  const seen = new Set();
  const add = file => {
    const key = path.resolve(file).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      files.push(file);
    }
  };
  for (const base of [...new Set(dirs.map(d => path.resolve(d)))]) {
    for (const rel of INIT_DIRS) {
      const dir = path.join(base, rel);
      if (!isDir(dir)) continue;
      fs.readdirSync(dir).filter(f => /\.sql$/i.test(f)).sort().forEach(f => add(path.join(dir, f)));
    }
    for (const rel of INIT_FILE_DIRS) {
      const dir = path.join(base, rel);
      if (!isDir(dir)) continue;
      fs.readdirSync(dir).filter(f => INIT_FILE_RE.test(f)).sort().forEach(f => add(path.join(dir, f)));
    }
  }
  return files.filter(f => fs.statSync(f).isFile());
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readPackageName(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')).name || null;
  } catch {
    return null;
  }
}

function defaultDbName(name) {
  const cleaned = String(name || 'app').replace(/^@[^/]+\//, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z_]/.test(cleaned) ? cleaned.slice(0, 60) : `app_${cleaned}`.slice(0, 60);
}

module.exports = {
  buildProjectModel,
  SECRET_PLACEHOLDER,
  ProjectError,
  parseConnectionUrl,
  collectConnectionRefs,
  imageEnvironment,
  latestTestedSeries,
  findInitScripts,
  scanCode,
  isLocalHost
};
