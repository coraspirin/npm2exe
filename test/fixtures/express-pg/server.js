require('dotenv/config');
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD
});

const app = express();

app.get('/', async (req, res) => {
  const visits = await redis.incr('visits');
  const { rows } = await pool.query('SELECT text FROM notes ORDER BY id');
  res.send(`<h1>express-pg-demo</h1><p>ziyaret: ${visits}</p><ul>${rows.map(r => `<li>${r.text}</li>`).join('')}</ul>`);
});

app.post('/notes', express.json(), async (req, res) => {
  await pool.query('INSERT INTO notes (text) VALUES ($1)', [String(req.body.text || '')]);
  res.status(201).end();
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
