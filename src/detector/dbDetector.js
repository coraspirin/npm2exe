const fs = require('fs');
const path = require('path');

/**
 * package.json bağımlılıklarından (ve Prisma şemasından) uygulamanın kullandığı veritabanlarını bulur.
 * Sürücü paketi esas alınır: ORM'ler (sequelize, knex, typeorm, drizzle) sürücüyü ayrıca bağımlılık olarak ister.
 */
const DRIVERS = {
  postgres: ['pg', 'postgres', 'pg-promise', 'slonik', '@mikro-orm/postgresql', '@vercel/postgres'],
  mysql: ['mysql', 'mysql2', '@mikro-orm/mysql'],
  mariadb: ['mariadb', '@mikro-orm/mariadb'],
  mongo: ['mongodb', 'mongoose', '@typegoose/typegoose', '@mikro-orm/mongodb'],
  redis: ['redis', 'ioredis', 'bull', 'bullmq', 'bee-queue', 'connect-redis', '@redis/client']
};
const SQLITE_PACKAGES = ['sqlite3', 'better-sqlite3', 'sqlite', '@libsql/client', 'libsql', 'sql.js'];
// Bulut DB'lerin HTTP sürücüleri: yerel bir sunucu gömmek anlamsız
const CLOUD_ONLY = ['@neondatabase/serverless', '@planetscale/database', '@supabase/supabase-js', 'firebase', 'firebase-admin'];
const PRISMA_PROVIDERS = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', mongodb: 'mongo', sqlite: 'sqlite', cockroachdb: 'postgres' };
const DB_TYPES = Object.keys(DRIVERS);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/**
 * @param {string[]} dirs uygulama klasörü ve proje kökü (package.json'ları birleştirilir)
 * @returns {{ types: Array<{ type: string, via: string[] }>, sqlite: string[], cloud: string[], prisma: string|null }}
 */
function detectDatabases(dirs) {
  const deps = {};
  for (const dir of [...new Set(dirs)]) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg) Object.assign(deps, pkg.devDependencies || {}, pkg.dependencies || {});
  }
  const found = new Map();
  const add = (type, via) => {
    if (!found.has(type)) found.set(type, []);
    found.get(type).push(via);
  };
  for (const type of DB_TYPES) {
    for (const name of DRIVERS[type]) if (deps[name]) add(type, name);
  }
  // mysql2 MariaDB'ye de bağlanır; sadece `mariadb` sürücüsü varsa MariaDB, ikisi birden varsa MySQL kabul edilir.
  if (found.has('mariadb') && found.has('mysql')) found.delete('mariadb');

  let prisma = null;
  if (deps.prisma || deps['@prisma/client']) {
    prisma = prismaProvider(dirs);
    const type = prisma && PRISMA_PROVIDERS[prisma];
    if (type && type !== 'sqlite') add(type, `prisma (${prisma})`);
  }

  return {
    types: DB_TYPES.filter(t => found.has(t)).map(t => ({ type: t, via: found.get(t) })),
    sqlite: SQLITE_PACKAGES.filter(p => deps[p]).concat(prisma === 'sqlite' ? ['prisma (sqlite)'] : []),
    cloud: CLOUD_ONLY.filter(p => deps[p]),
    prisma
  };
}

/** schema.prisma'daki `datasource { provider = "..." }` değeri. */
function prismaProvider(dirs) {
  for (const dir of [...new Set(dirs)]) {
    const pkg = readJson(path.join(dir, 'package.json')) || {};
    const custom = pkg.prisma && typeof pkg.prisma.schema === 'string' ? [pkg.prisma.schema] : [];
    for (const rel of [...custom, 'prisma/schema.prisma', 'schema.prisma']) {
      let file = path.join(dir, rel);
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'schema.prisma');
        const text = fs.readFileSync(file, 'utf8');
        const block = /datasource\s+\w+\s*\{([^}]*)\}/.exec(text);
        const m = block && /provider\s*=\s*"([^"]+)"/.exec(block[1]);
        if (m) return m[1].toLowerCase();
      } catch {
        // sonraki aday
      }
    }
  }
  return null;
}

module.exports = { detectDatabases, DB_TYPES, DRIVERS, SQLITE_PACKAGES };
