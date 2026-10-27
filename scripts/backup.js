'use strict';

// Backup online do SQLite (API de backup: consistente mesmo com o app rodando).
// Uso: npm run backup -- [diretório] ; BACKUP_KEEP define quantos manter (padrão 14).
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');

async function main() {
  const { databasePath } = loadConfig();
  const dir = path.resolve(process.argv[2] || path.join(path.dirname(databasePath), 'backups'));
  const keep = Number(process.env.BACKUP_KEEP) || 14;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('BACKUP_KEEP deve ser um inteiro positivo.');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `estoquecerto-${stamp}.sqlite`);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  // Cópia em arquivo único (sem -wal/-shm) e conferida antes de apagar backups antigos.
  const copy = new Database(target);
  try {
    copy.pragma('journal_mode = DELETE');
    const result = copy.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup corrompido: ${result}`);
  } finally {
    copy.close();
  }

  const old = fs
    .readdirSync(dir)
    .filter(f => /^estoquecerto-.*\.sqlite$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const file of old) fs.unlinkSync(path.join(dir, file));
  console.log(JSON.stringify({ msg: 'backup_done', target, removed: old.length }));
}

main().catch(err => {
  console.error(JSON.stringify({ msg: 'backup_failed', error: err.message }));
  process.exit(1);
});
