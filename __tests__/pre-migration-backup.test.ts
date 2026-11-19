import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import {
  runMigrations,
  setDb,
  closeDb,
  getLastPreMigrationBackupPath,
} from "../src/indexer/db.js";
function migrationVersionsFromSource(): number[] {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/indexer/db.ts"),
    "utf8",
  );
  const versions: number[] = [];
  const re = /version:\s*(\d+)\s*,\s*\n\s*description:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) versions.push(Number(m[1]));
  return versions.sort((a, b) => a - b);
}

const MIGRATION_VERSIONS = migrationVersionsFromSource();

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-mig-"));
  return path.join(dir, "escrow.db");
}

afterEach(() => {
  try {
    closeDb();
  } catch {
    // already closed by the test
  }
  delete process.env.DB_PATH;
});

describe("pre-migration SQLite backups (#955)", () => {
  it("creates a pre-migration backup when migrations are pending", () => {
    const dbPath = tmpDbPath();
    process.env.DB_PATH = dbPath;
    const db = new Database(dbPath);
    setDb(db, dbPath);

    runMigrations();

    const backupPath = `${dbPath}.pre-v1.bak`;
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(getLastPreMigrationBackupPath()).toBe(backupPath);

    const backup = new Database(backupPath, { readonly: true });
    const row = backup
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    expect(row).toBeUndefined();
    backup.close();
    db.close();
  });

  it("does not create a backup when no migrations are pending", () => {
    const dbPath = tmpDbPath();
    process.env.DB_PATH = dbPath;
    const db = new Database(dbPath);
    setDb(db, dbPath);

    runMigrations();
    const backupPath = `${dbPath}.pre-v1.bak`;
    const stat1 = fs.existsSync(backupPath) ? fs.statSync(backupPath).mtimeMs : 0;

    runMigrations();
    const stat2 = fs.existsSync(backupPath) ? fs.statSync(backupPath).mtimeMs : 0;
    expect(stat2).toBe(stat1);
    expect(getLastPreMigrationBackupPath()).toBeNull();
    db.close();
  });

  it("keeps only the last two pre-migration backups", () => {
    const dbPath = tmpDbPath();
    for (let v = 1; v <= 4; v++) {
      fs.writeFileSync(`${dbPath}.pre-v${v}.bak`, `backup-${v}`);
      const t = Date.now() - (10 - v) * 1000;
      fs.utimesSync(`${dbPath}.pre-v${v}.bak`, t / 1000, t / 1000);
    }
    process.env.DB_PATH = dbPath;
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    for (const v of MIGRATION_VERSIONS.slice(0, -1)) {
      db.prepare("INSERT INTO schema_migrations (version, description) VALUES (?, ?)").run(v, `v${v}`);
    }
    setDb(db, dbPath);

    runMigrations();

    const last = MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1];
    const files = fs
      .readdirSync(path.dirname(dbPath))
      .filter((n) => n.startsWith("escrow.db.pre-v") && n.endsWith(".bak"))
      .sort();
    expect(files.length).toBe(2);
    expect(files).toContain(`escrow.db.pre-v${last}.bak`);
    db.close();
  });
});
