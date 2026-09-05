import { resolveTestDatabaseUrl } from "./test-database-url";

/**
 * Points the process at the disposable test branch before any module that reads
 * DATABASE_URL at import time is loaded.
 */
const { url, directUrl } = resolveTestDatabaseUrl();

process.env.DATABASE_URL = url;
process.env.DIRECT_URL = directUrl;
