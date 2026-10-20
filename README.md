# npm2exe

Bir Node.js web uygulamasını, kullandığı veritabanlarıyla birlikte Windows'ta çalışan **tek bir exe'ye** dönüştürür. Docker, Dockerfile veya docker-compose gerekmez: proje klasörünü seçip **Exe oluştur**'a basmanız yeter. Veritabanları (PostgreSQL, MySQL, MariaDB, MongoDB, Redis) `package.json`'daki sürücülerden tespit edilir, bağlantı bilgisi `.env`'den okunur ve gerçek Windows binary'leri olarak pakete gömülür. Uygulama kodunuz değiştirilmez.

```
npm2exe.exe  →  proje klasörünü sürükle  →  [Exe oluştur]  →  build-output\my-app.exe  →  hedef makinede çift tıkla
```

> Projeniz docker-compose ile çalışıyorsa kardeş araç [docker2exe](https://github.com/coraspirin/Docker2exe) compose dosyasını doğrudan okur. npm2exe, Docker kullanmayan projeler içindir. İki araç aynı çalışma zamanını (launcher, tek dosya exe, DB motorları) kullanır; ortak koddaki düzeltmeler iki repoya ayrı ayrı taşınır.

## İçindekiler

- [Gereksinimler](#gereksinimler)
- [1. npm2exe'yi hazırlama](#1-npm2exeyi-hazırlama)
- [2. Uygulamanızı paketleme](#2-uygulamanızı-paketleme)
- [3. Veritabanları nasıl bulunur](#3-veritabanları-nasıl-bulunur)
- [4. Paketi hedef makinede çalıştırma](#4-paketi-hedef-makinede-çalıştırma)
- [Sorun giderme](#sorun-giderme)
- [Referans](#referans)

## Gereksinimler

| | Build makinesi (paketi üreten) | Hedef makine (paketi çalıştıran) |
|---|---|---|
| İşletim sistemi | Windows 10 1803+ / 11, x64 | Windows 10 1803+ / 11, x64 |
| Node.js | `npm2exe.exe` ile **gerekmez** (içinde gömülü). Kaynaktan çalıştırırken 22+ | Gerekmez |
| Diğer | İnternet (ilk build'de DB binary'leri ve npm paketleri iner), git (sadece GitHub kaynağı için) | Gerekmez (.NET Framework 4.8 Windows'ta hazır gelir) |

Paketlenecek proje: kökünde (veya `server/`, `backend/`, `api/`, `app/` altında) `package.json` bulunan, `scripts.start` veya `main` ile başlatılan bir Node.js web uygulaması.

## 1. npm2exe'yi hazırlama

Bir kez yapılır; sonuç başka makinelere de kopyalanabilen tek dosya `dist\npm2exe.exe`'dir.

```bash
git clone <bu repo>
cd npm2exe
npm install
npm run build:exe
```

> **Exe üretmeden kullanmak:** `npm install` sonrası `node src/cli.js <proje-klasörü>` aynı işi komut satırından yapar (Node.js 22+).

## 2. Uygulamanızı paketleme

### Pencereden (tek tuş)

1. `npm2exe.exe`'yi çift tıklayın.
2. Proje klasörünü pencereye sürükleyin (veya **Gözat...**).
3. **Exe oluştur**'a basın.

Pencere ilerlemeyi, gömülecek veritabanlarını ve build günlüğünü gösterir. Bitince **Exe'yi çalıştır** ve **Klasörü aç** düğmeleri etkinleşir. Proje klasörünü doğrudan `npm2exe.exe`'nin **üzerine bırakırsanız** pencere açılır ve build hemen başlar.

Varsayılan çıktı tek exe'dir; isterseniz **Klasör** (Başlat.bat / Durdur.bat) ve **Zip** de seçebilirsiniz. Çıktı `npm2exe.exe`'nin yanındaki `build-output\` klasörüne yazılır (pencereden değiştirilebilir).

### Komut satırından

```bash
npm2exe C:\Projeler\my-app                    # analiz + build (çıktı türü sorulur)
npm2exe C:\Projeler\my-app --check            # sadece analiz raporu
npm2exe C:\Projeler\my-app --format exe,zip   # sormadan exe + zip
npm2exe C:\Projeler\my-app --db postgres      # tespiti geçersiz kıl: sadece postgres göm
npm2exe C:\Projeler\my-app --pg-version 16    # varsayılan yerine postgres 16
npm2exe https://github.com/user/repo --branch develop
```

Build önce projeyi analiz eder (**pre-flight**): giriş dosyası, port, Node sürümü, veritabanları ve bağlantıları. Bir şey belirlenemezse (örn. port) hata ve çözüm bayrağı yazılır, build başlamaz. Ayrıntılı günlük: `build-output\<uygulama>.build.log`.

## 3. Veritabanları nasıl bulunur

**Hangi veritabanı:** `package.json` (`dependencies` + `devDependencies`) sürücülerine bakılır.

| Veritabanı | Sürücüler |
|---|---|
| PostgreSQL | `pg`, `postgres`, `pg-promise`, `slonik`, `@mikro-orm/postgresql`; Prisma `provider = "postgresql"` |
| MySQL | `mysql`, `mysql2`, `@mikro-orm/mysql`; Prisma `provider = "mysql"` |
| MariaDB | `mariadb` (yanında `mysql2` de varsa MySQL kabul edilir) |
| MongoDB | `mongodb`, `mongoose`, `@typegoose/typegoose`; Prisma `provider = "mongodb"` |
| Redis | `redis`, `ioredis`, `bull`, `bullmq`, `bee-queue`, `connect-redis` |

SQLite (`sqlite3`, `better-sqlite3` ...) ayrı sunucu gerektirmez. Bulut istemcileri (`@neondatabase/serverless`, `@supabase/supabase-js`, `firebase` ...) gömülmez.

**Bağlantı bilgisi:** `.env` okunur (yoksa `.env.example` / `.env.sample`, uyarıyla). Uygulama `server/` gibi bir alt klasördeyse oradaki `.env` önceliklidir. `${VAR}` referansları genişletilir.

- URL'ler (`DATABASE_URL=postgres://user:şifre@localhost:5432/db`, `MONGO_URI=mongodb://...`, `REDIS_URL=redis://:şifre@localhost:6379`) anahtar adından bağımsız olarak şemadan tanınır.
- Ayrık değişkenler: `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`, `PGHOST/PGUSER/...`, `POSTGRES_*`, `MYSQL_*`, `MONGO_*`, `REDIS_HOST/REDIS_PORT/REDIS_PASSWORD`. Genel `DB_*` değişkenleri projedeki SQL veritabanına bağlanır (ikisi birden varsa `DB_DIALECT`/`DB_CLIENT`'a bakılır).
- Gömülü veritabanı **bu bilgilerle kurulur**: aynı kullanıcı, şifre, DB adı ve port. Uygulamaya giden değerlerde `localhost` → `127.0.0.1` yapılır; hedef makinede port doluysa launcher başka port seçer ve bu değişkenleri günceller.
- `.env` uzak bir sunucuyu gösteriyorsa (`db.example.com`, MongoDB Atlas `mongodb+srv://`) o veritabanı **gömülmez**; uygulama oraya bağlanmaya devam eder. Yine de gömmek için `--db <tür>`.
- MongoDB'de kullanıcılı URL'e `authSource=admin` eklenir (gömülü MongoDB'de kullanıcı admin veritabanında oluşur).

**`.env`'de bilgi yoksa** kod taranır. Kod `process.env.MONGODB_URI` gibi bir değişken okuyorsa bu değişken üretilir (koddaki `|| 'mongodb://localhost/notlar'` varsayılanından DB adı ve port alınır). Üretilen URL veya şifre değişkenine **rastgele bir şifre** konur (MongoDB'de `app` kullanıcısıyla). Şifre pakete girmez: hedef makinede ilk çalıştırmada üretilir ve `%LOCALAPPDATA%\<app>\data\.d2e-db-secret` dosyasında saklanır, yani her kurulumun şifresi farklıdır. Şifreyi uygulamaya iletecek bir değişken yoksa (adres kodda sabitse veya hiç ipucu yoksa) veritabanı kimlik doğrulamasız çalışır ve build uyarı verir: gömülü veritabanları sadece `127.0.0.1`'de dinler ama aynı bilgisayardaki diğer kullanıcılar erişebilir.

**Sürüm:** `.env`'de `POSTGRES_VERSION`, `MYSQL_VERSION`, `MONGO_VERSION`, `REDIS_VERSION` ... varsa o; yoksa `--pg-version` gibi bayrak; o da yoksa manifest'teki **en yeni test edilmiş** seri (raporda "varsayılan").

**İlk kurulum SQL'i:** `init/`, `initdb/`, `db/init/`, `docker-entrypoint-initdb.d/` klasörlerindeki tüm `.sql` dosyaları ile kök, `db/`, `sql/`, `database/` altındaki `init*.sql`, `schema*.sql`, `seed*.sql`, `setup*.sql` dosyaları veritabanı ilk kez kurulurken çalıştırılır. Migration klasörleri çalıştırılmaz (onları uygulamanız yapar).

## 4. Paketi hedef makinede çalıştırma

1. `<Uygulama>.exe`'yi hedef makineye kopyalayın. Kurulum yoktur.
2. **Çift tıklayın.** İlk açılışta kendini `%LOCALAPPDATA%\<app>\app\` altına açar; sonraki açılışlar anında başlar.
3. Durum penceresi veritabanlarını başlatır, uygulama hazır olunca tarayıcıyı açar.
4. **Kapatmak için pencereyi kapatın.** Uygulama ve veritabanları düzgünce durdurulur.

| Ne | Nerede |
|---|---|
| Veritabanı dosyaları | `%LOCALAPPDATA%\<app>\data\` (güncellemede korunur) |
| Loglar | `%LOCALAPPDATA%\<app>\logs\` (`launcher.log`, `app.log`, `postgres.log` ...) |

Güncelleme: yeni exe'yi eskisinin yerine koyup çalıştırın; veriler korunur.

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| "Windows bilgisayarınızı korudu" (SmartScreen) | Exe'ler imzasızdır: **Ek bilgi → Yine de çalıştır**. |
| Yanlış veritabanı tespit edildi / gereksiz biri gömülüyor | `--db postgres,redis` ile listeyi kendiniz verin; hiç gömmemek için `--db none`. |
| Uygulama veritabanına bağlanamıyor | `--check` raporundaki "Bağlantı değişkenleri" tablosuna bakın; bağlantı adresini koda yazmak yerine `.env`'deki bir değişkenden okuyun. |
| Port tespit edilemedi | `.env`'e `PORT=3000` ekleyin veya `--port 3000`. |
| Build npm adımında hata verdi | `build-output\<uygulama>.build.log` dosyasında komutun tam çıktısı bulunur. |
| Kurumsal ağda indirme hatası | `HTTP_PROXY`/`HTTPS_PROXY`; SSL inceleme için `NODE_EXTRA_CA_CERTS`, son çare `--insecure`. |

## Referans

### Bayraklar

`npm2exe <proje-klasörü | github-url> [bayraklar]`

| Bayrak | Açıklama |
|---|---|
| `--format <exe,klasor,zip,hepsi>` | Çıktı türleri. Verilmezse sorulur; terminal etkileşimli değilse üçü de üretilir |
| `--check`, `--json` | Sadece pre-flight raporu (metin / JSON; şifreler maskelenir) |
| `--db <türler>` | Gömülecek veritabanları: `postgres`, `mysql`, `mariadb`, `mongo`, `redis` (virgülle) veya `none`. Tespiti geçersiz kılar; uzak sunucu gösteren bağlantıları da yerelleştirir |
| `--pg-version`, `--mysql-version`, `--mariadb-version`, `--mongo-version`, `--redis-version` | Veritabanı sürümü (varsayılan: en yeni test edilmiş) |
| `--db-version <db=versiyon>` | Aynısı, `postgres=16` biçiminde |
| `--entry <dosya>`, `--port <n>` | Otomatik tespit başarısız olursa |
| `--node-target <22\|24\|26>` | Paketlenecek Node sürümü (varsayılan: `.nvmrc` / `.node-version` / `engines.node`; paketleme hedefi olmayan sürümler, engines izin veriyorsa bir üst LTS'e yükseltilir) |
| `--redis-engine <redis-windows\|memurai>` | `memurai`: Redis gömülmez, hedef makinedeki Memurai servisi kullanılır |
| `--name`, `--out` | Uygulama adı, çıktı klasörü (varsayılan `build-output`) |
| `--branch`, `--token` | GitHub kaynağı için dal ve PAT (`GITHUB_TOKEN`) |
| `--offline`, `--insecure` | DB binary'lerini sadece cache'ten kullan / TLS doğrulamasını atla (SHA256 yine kontrol edilir) |
| `--desktop-shortcut` | Masaüstü kısayolu |

`npm2exe clean-cache [--keep-latest]`: indirilen DB binary cache'ini (`%USERPROFILE%\.npm2exe`) temizler.

### Desteklenen veritabanı sürümleri

Sürümler, URL'ler ve SHA256'lar [manifests/db-manifest.json](manifests/db-manifest.json) içindedir: PostgreSQL 14–18, MySQL 8.4 / 9.7, MariaDB 10.11 / 11.4 / 11.8 / 12.3, MongoDB 7.0 / 8.0, Redis 6 / 7 / 8. Hepsi `npm run test:e2e` ile gerçek binary'lerle doğrulanır.

### Pipeline

```
Kaynak → package.json + .env (DB tespiti, bağlantı çıkarımı, localhost → 127.0.0.1) → Stack tespiti (entry, port, Node)
→ DB pre-flight → DB binary (indirme + SHA256 + cache) → Frontend build → npm install → native modül kontrolü
→ pkg (app.exe) → launcher.exe → klasör → zip → tek exe
```

Proje modeli ([src/parser/projectModel.js](src/parser/projectModel.js)) docker2exe'nin compose modeliyle aynı şekildedir; build zincirinin geri kalanı ve çalışma zamanı ortaktır.

### Arayüz

`npm2exe.exe` bir konsol SFX stub'ıdır ([runtime/sfx/Sfx.cs](runtime/sfx/Sfx.cs), `/define:TOOLGUI`). Explorer'dan açıldığında (argüman yoksa veya tek argüman bir klasörse) konsolu gizleyip [runtime/gui/BuilderWindow.cs](runtime/gui/BuilderWindow.cs) penceresini açar; terminalden argümanla çalıştırıldığında doğrudan CLI'dir. Pencere build'i `node cli.js --gui-protocol` alt süreci olarak çalıştırır; `@@NPM2EXE {json}` satırları ilerleme ve sonucu taşır.

### Bilinen sınırlamalar

- Sadece Windows x64; build makinesi de Windows olmalı.
- Bağlantı adresi kodda sabit yazılıysa (`mongoose.connect('mongodb://localhost/x')`) ve hedef makinede o port doluysa uygulama bağlanamaz; adresi ortam değişkeninden okuyun.
- Prisma migration'ları otomatik uygulanmaz; uygulamanız başlangıçta `prisma migrate deploy` çalıştırmalıdır.
- SQLite kullanan uygulamalar DB yolunu `process.env.SQLITE_DB_PATH` (yazılabilir veri klasörü) üzerinden okumalıdır.
- V8 ABI'ye bağlı native modüller build'i çalıştıran Node ile derlenir; N-API modülleri sürümden bağımsızdır.
- Next.js için `output: 'standalone'`, SvelteKit için `adapter-node` gereklidir.
- Exe'ler kod imzalı değildir.

### Geliştirme

```bash
npm test             # birim testleri (node:test)
npm run test:e2e     # manifest'teki tüm DB sürümleri (indirme gerektirir)
npm run build:exe    # dist\npm2exe.exe
```

Fixture'lar (`test/fixtures/`): `express-pg` (Express + Postgres + Redis, `.env` ile, `db/init.sql`), `mongoose-noenv` (ESM + MongoDB, `.env` yok; bağlantı koddan).
