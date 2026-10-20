const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { detectDatabases } = require('../src/detector/dbDetector');
const { buildProjectModel, SECRET_PLACEHOLDER, parseConnectionUrl, latestTestedSeries, isLocalHost, ProjectError } = require('../src/parser/projectModel');
const { loadManifest } = require('../src/compatibility/versionResolver');
const { makeProject, removeProject } = require('./helpers');

const manifest = loadManifest();
const pkg = obj => JSON.stringify(obj);

function withProject(files, fn, options = {}) {
  const dir = makeProject(files);
  try {
    return fn(buildProjectModel(dir, { manifest, ...options }), dir);
  } finally {
    removeProject(dir);
  }
}

const db = (model, type) => model.dependencyServices.find(s => s.dbType === type);

// --- dbDetector ---

test('dbDetector: sürücü paketlerinden DB tipleri', () => {
  const dir = makeProject({
    'package.json': pkg({ dependencies: { pg: '8', mongoose: '8', bullmq: '5', 'better-sqlite3': '11', '@neondatabase/serverless': '1' } })
  });
  try {
    const r = detectDatabases([dir]);
    assert.deepEqual(r.types.map(t => t.type), ['postgres', 'mongo', 'redis']);
    assert.deepEqual(r.sqlite, ['better-sqlite3']);
    assert.deepEqual(r.cloud, ['@neondatabase/serverless']);
  } finally {
    removeProject(dir);
  }
});

test('dbDetector: mariadb sürücüsü tek başına MariaDB, mysql2 ile birlikte MySQL', () => {
  const only = makeProject({ 'package.json': pkg({ dependencies: { mariadb: '3' } }) });
  const both = makeProject({ 'package.json': pkg({ dependencies: { mariadb: '3', mysql2: '3' } }) });
  try {
    assert.deepEqual(detectDatabases([only]).types.map(t => t.type), ['mariadb']);
    assert.deepEqual(detectDatabases([both]).types.map(t => t.type), ['mysql']);
  } finally {
    removeProject(only);
    removeProject(both);
  }
});

test('dbDetector: Prisma provider şemadan okunur', () => {
  const dir = makeProject({
    'package.json': pkg({ dependencies: { '@prisma/client': '6' }, devDependencies: { prisma: '6' } }),
    'prisma/schema.prisma': 'generator client {\n  provider = "prisma-client-js"\n}\ndatasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n'
  });
  try {
    const r = detectDatabases([dir]);
    assert.equal(r.prisma, 'mysql');
    assert.deepEqual(r.types, [{ type: 'mysql', via: ['prisma (mysql)'] }]);
  } finally {
    removeProject(dir);
  }
});

// --- URL / host yardımcıları ---

test('parseConnectionUrl: kullanıcı, şifre (@ içeren), port, DB adı', () => {
  const u = parseConnectionUrl('postgresql://app:p@ss@localhost:5433/shop?sslmode=disable');
  assert.deepEqual([u.family, u.user, u.password, u.port, u.database, u.query], ['postgres', 'app', 'p@ss', 5433, 'shop', 'sslmode=disable']);
  assert.equal(parseConnectionUrl('redis://:secret@127.0.0.1:6380/2').database, null);
  assert.equal(parseConnectionUrl('https://example.com'), null);
});

test('isLocalHost: localhost, loopback ve Docker servis adları yerel; alan adları uzak', () => {
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('db'), true);
  assert.equal(isLocalHost('db.example.com'), false);
  assert.equal(isLocalHost('10.0.0.5'), false);
});

test('latestTestedSeries: en yeni desteklenen ve test edilmiş seri', () => {
  assert.equal(latestTestedSeries(manifest.postgres), '18');
  assert.equal(latestTestedSeries({ supported_majors: ['7.0', '8.0', '10.0'], versions: { '7.0': {}, '8.0': {}, '10.0': { tested: false } } }), '8.0');
});

// --- proje modeli ---

test('model: .env DATABASE_URL → postgres kimlik bilgileri, localhost → 127.0.0.1, port referansı', () => {
  withProject({
    'package.json': pkg({ name: 'shop', scripts: { start: 'node index.js' }, dependencies: { pg: '8' } }),
    'index.js': '',
    '.env': 'PORT=3000\nDATABASE_URL=postgres://shop:gizli@localhost:5433/shop_db\n'
  }, m => {
    const pg = db(m, 'postgres');
    assert.deepEqual(pg.environment, { POSTGRES_USER: 'shop', POSTGRES_PASSWORD: 'gizli', POSTGRES_DB: 'shop_db' });
    assert.deepEqual(pg.expose, [5433]);
    assert.equal(pg.imageTag, '18');
    assert.equal(m.webService.resolvedEnvironment.DATABASE_URL, 'postgres://shop:gizli@127.0.0.1:5433/shop_db');
    assert.deepEqual(m.webService.remaps.map(r => [r.key, r.kind, r.targets]), [['DATABASE_URL', 'url', [{ service: 'postgres', port: 5433 }]]]);
    assert.equal(m.webService.resolvedEnvironment.NODE_ENV, 'production');
  });
});

test('model: ayrık DB_* değişkenleri mysql\'e bağlanır; root şifresi', () => {
  withProject({
    'package.json': pkg({ main: 'a.js', dependencies: { mysql2: '3' } }),
    'a.js': '',
    '.env': 'DB_HOST=localhost\nDB_PORT=3307\nDB_USER=root\nDB_PASSWORD=kök\nDB_NAME=blog\n'
  }, m => {
    const my = db(m, 'mysql');
    assert.deepEqual(my.environment, { MYSQL_ROOT_PASSWORD: 'kök', MYSQL_DATABASE: 'blog' });
    assert.deepEqual(my.expose, [3307]);
    assert.equal(m.webService.resolvedEnvironment.DB_HOST, '127.0.0.1');
    assert.deepEqual(m.webService.remaps[0].targets, [{ service: 'mysql', port: null }]);
  });
});

test('model: mysql kullanıcı root değilse MYSQL_USER/PASSWORD', () => {
  withProject({
    'package.json': pkg({ main: 'a.js', dependencies: { mysql2: '3' } }),
    'a.js': '',
    '.env': 'MYSQL_URL=mysql://blog:pw@127.0.0.1/blog\n'
  }, m => {
    assert.deepEqual(db(m, 'mysql').environment, { MYSQL_USER: 'blog', MYSQL_PASSWORD: 'pw', MYSQL_ROOT_PASSWORD: 'pw', MYSQL_DATABASE: 'blog' });
  });
});

test('model: şifresiz postgres trust, şifreli redis requirepass', () => {
  withProject({
    'package.json': pkg({ main: 'a.js', dependencies: { pg: '8', ioredis: '5' } }),
    'a.js': '',
    '.env': 'PGHOST=localhost\nPGUSER=me\nREDIS_URL=redis://:rpw@localhost:6379\n'
  }, m => {
    assert.deepEqual(db(m, 'postgres').environment, { POSTGRES_USER: 'me', POSTGRES_HOST_AUTH_METHOD: 'trust' });
    assert.deepEqual(db(m, 'redis').command, ['--requirepass', 'rpw']);
    assert.equal(m.webService.resolvedEnvironment.REDIS_URL, 'redis://:rpw@127.0.0.1:6379');
  });
});

test('model: MongoDB kullanıcılı URL\'e authSource=admin eklenir', () => {
  withProject({
    'package.json': pkg({ main: 'a.js', dependencies: { mongoose: '8' } }),
    'a.js': '',
    '.env': 'MONGO_URI=mongodb://u:p@localhost:27017/app\n'
  }, m => {
    assert.deepEqual(db(m, 'mongo').environment, { MONGO_INITDB_ROOT_USERNAME: 'u', MONGO_INITDB_ROOT_PASSWORD: 'p', MONGO_INITDB_DATABASE: 'app' });
    assert.equal(m.webService.resolvedEnvironment.MONGO_URI, 'mongodb://u:p@127.0.0.1:27017/app?authSource=admin');
  });
});

test('model: uzak sunucu gömülmez; --db ile zorlanırsa yerelleştirilir', () => {
  const files = {
    'package.json': pkg({ main: 'a.js', dependencies: { pg: '8' } }),
    'a.js': '',
    '.env': 'DATABASE_URL=postgres://u:p@db.example.com:5432/x\n'
  };
  withProject(files, m => {
    assert.equal(m.dependencyServices.length, 0);
    assert.ok(m.report.infos.some(i => i.includes('uzak bir sunucu')));
    assert.equal(m.webService.resolvedEnvironment.DATABASE_URL, 'postgres://u:p@db.example.com:5432/x');
  });
  withProject(files, m => {
    assert.equal(db(m, 'postgres').environment.POSTGRES_USER, 'u');
    assert.equal(m.webService.resolvedEnvironment.DATABASE_URL, 'postgres://u:p@127.0.0.1:5432/x');
  }, { db: ['postgres'] });
});

test('model: --db none hiçbir DB gömmez, bilinmeyen tip hata', () => {
  const files = { 'package.json': pkg({ main: 'a.js', dependencies: { pg: '8' } }), 'a.js': '' };
  withProject(files, m => assert.equal(m.dependencyServices.length, 0), { db: ['none'] });
  assert.throws(() => withProject(files, () => {}, { db: ['oracle'] }), ProjectError);
});

test('model: .env yoksa kodun okuduğu değişken üretilir, bilgi koddaki adresten', () => {
  withProject({
    'package.json': pkg({ name: 'notes', main: 'a.js', dependencies: { mongoose: '8' } }),
    'a.js': "mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27018/notlar');"
  }, m => {
    const mongo = db(m, 'mongo');
    assert.deepEqual(mongo.expose, [27018]);
    // Değişkeni biz ürettiğimiz için şifreli kullanıcı oluşturulur; şifre hedef makinede üretilir (yer tutucu)
    const pw = mongo.environment.MONGO_INITDB_ROOT_PASSWORD;
    assert.equal(pw, SECRET_PLACEHOLDER);
    assert.equal(mongo.environment.MONGO_INITDB_ROOT_USERNAME, 'app');
    assert.equal(m.webService.resolvedEnvironment.MONGODB_URI, `mongodb://app:${pw}@127.0.0.1:27018/notlar?authSource=admin`);
    assert.deepEqual(m.webService.remaps[0].targets, [{ service: 'mongo', port: 27018 }]);
  });
});

test('model: .env ve kod ipucu yoksa varsayılan port, DATABASE_URL okunuyorsa paket adıyla üretilir', () => {
  withProject({
    'package.json': pkg({ name: '@acme/my-app', main: 'a.js', dependencies: { pg: '8' } }),
    'a.js': 'const { DATABASE_URL } = process.env;'
  }, m => {
    const pg = db(m, 'postgres');
    const pw = pg.environment.POSTGRES_PASSWORD;
    assert.equal(pw, SECRET_PLACEHOLDER);
    assert.deepEqual(pg.environment, { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: pw, POSTGRES_DB: 'my_app' });
    assert.equal(m.webService.resolvedEnvironment.DATABASE_URL, `postgresql://postgres:${pw}@127.0.0.1:5432/my_app`);
  });
  // Sadece DB_HOST okunuyorsa şifre uygulamaya ulaşamaz → şifresiz kalır
  withProject({ 'package.json': pkg({ main: 'a.js', dependencies: { pg: '8' } }), 'a.js': 'process.env.DB_HOST' }, m => {
    assert.equal(db(m, 'postgres').environment.POSTGRES_HOST_AUTH_METHOD, 'trust');
  });
  withProject({ 'package.json': pkg({ main: 'a.js', dependencies: { redis: '4' } }), 'a.js': '' }, m => {
    assert.deepEqual(db(m, 'redis').expose, [6379]);
    assert.ok(m.report.warnings.some(w => w.includes('kimlik doğrulamasız')));
  });
});

test('model: .env yoksa .env.example kullanılır (uyarıyla); ${VAR} genişletilir', () => {
  withProject({
    'package.json': pkg({ main: 'a.js', dependencies: { pg: '8' } }),
    'a.js': '',
    '.env.example': 'DB_USER=app\nDB_PASS=x\nDATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost/app\n'
  }, m => {
    assert.deepEqual(m.report.envFiles, ['.env.example']);
    assert.ok(m.report.warnings.some(w => w.includes('.env yok')));
    assert.equal(m.webService.resolvedEnvironment.DATABASE_URL, 'postgres://app:x@127.0.0.1/app');
    assert.equal(db(m, 'postgres').environment.POSTGRES_USER, 'app');
  });
});

test('model: .env sürüm ipucu ve CLI override', () => {
  const files = { 'package.json': pkg({ main: 'a.js', dependencies: { pg: '8' } }), 'a.js': '', '.env': 'POSTGRES_VERSION=16\n' };
  withProject(files, m => {
    assert.equal(db(m, 'postgres').imageTag, '16');
    assert.equal(db(m, 'postgres').versionSource, '.env POSTGRES_VERSION');
  });
  withProject({ ...files, '.env': '' }, m => assert.equal(db(m, 'postgres').imageTag, null), { overrides: { byService: {}, byType: { postgres: '15' } } });
});

test('model: init SQL dosyaları (init klasörü + schema/seed adları), migration\'lar hariç', () => {
  withProject({
    'package.json': pkg({ main: 'a.js', dependencies: { pg: '8' } }),
    'a.js': '',
    'db/init/01-tables.sql': '',
    'db/schema.sql': '',
    'db/migrations/001.sql': '',
    'notes.sql': ''
  }, (m, dir) => {
    const rel = db(m, 'postgres').initFiles.map(f => path.relative(dir, f).split(path.sep).join('/'));
    assert.deepEqual(rel, ['db/init/01-tables.sql', 'db/schema.sql']);
  });
});

test('model: uygulama server/ altındaysa .env ve bağımlılıklar oradan da okunur', () => {
  withProject({
    'package.json': pkg({ name: 'root', scripts: { dev: 'x' } }),
    'server/package.json': pkg({ name: 'srv', scripts: { start: 'node index.js' }, dependencies: { mysql2: '3' } }),
    'server/index.js': '',
    'server/.env': 'DATABASE_URL=mysql://root:pw@localhost:3306/app\n'
  }, (m, dir) => {
    assert.equal(m.appDir, path.join(dir, 'server'));
    assert.deepEqual(m.report.envFiles, ['server/.env']);
    assert.equal(db(m, 'mysql').environment.MYSQL_ROOT_PASSWORD, 'pw');
  });
});
