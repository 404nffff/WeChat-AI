import { migrate, openDatabase } from "./client.js";
import { defaultDbPath } from "./paths.js";

const dbPath = defaultDbPath();
const db = openDatabase(dbPath);
migrate(db);
console.log(`Migrated database at ${dbPath}`);
db.close();
