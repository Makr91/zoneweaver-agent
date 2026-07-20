import { stat } from 'fs/promises';
import { allDatabases } from '../../config/Database.js';
import { log } from '../../lib/Logger.js';

/**
 * Get file size safely, returning 0 if file doesn't exist
 * @param {string} filePath - Path to file
 * @returns {Promise<number>} File size in bytes
 */
const getFileSizeOrZero = async filePath => {
  try {
    const fileStat = await stat(filePath);
    return fileStat.size;
  } catch (error) {
    void error;
    return 0;
  }
};

const collectDatabaseStats = async ({ name, file, instance }) => {
  const [dbSize, walSize, shmSize] = await Promise.all([
    getFileSizeOrZero(file),
    getFileSizeOrZero(`${file}-wal`),
    getFileSizeOrZero(`${file}-shm`),
  ]);

  const [tables] = await instance.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  const tableStats = await Promise.all(
    tables.map(async table => {
      const [[countResult]] = await instance.query(`SELECT COUNT(*) as count FROM "${table.name}"`);
      return {
        name: table.name,
        row_count: countResult.count,
      };
    })
  );

  const [indexes] = await instance.query(
    "SELECT name, tbl_name as 'table' FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name"
  );

  const [[pageCount]] = await instance.query('PRAGMA page_count');
  const [[pageSize]] = await instance.query('PRAGMA page_size');
  const [[freelistCount]] = await instance.query('PRAGMA freelist_count');

  return {
    name,
    storage_path: file,
    files: {
      database: dbSize,
      wal: walSize,
      shm: shmSize,
      total: dbSize + walSize + shmSize,
    },
    internal: {
      page_size: pageSize.page_size,
      page_count: pageCount.page_count,
      freelist_count: freelistCount.freelist_count,
      freelist_bytes: freelistCount.freelist_count * pageSize.page_size,
    },
    tables: tableStats,
    total_tables: tableStats.length,
    total_rows: tableStats.reduce((sum, t) => sum + t.row_count, 0),
    indexes: indexes.map(idx => ({ name: idx.name, table: idx.table })),
    total_indexes: indexes.length,
  };
};

export const collectAllDatabaseStats = () =>
  Promise.all(allDatabases.map(database => collectDatabaseStats(database)));

export const summarizeDatabaseTotals = databases => ({
  total_size: databases.reduce((sum, d) => sum + d.files.total, 0),
  total_tables: databases.reduce((sum, d) => sum + d.total_tables, 0),
  total_rows: databases.reduce((sum, d) => sum + d.total_rows, 0),
});

const vacuumSingleDatabase = async ({ name, file, instance }) => {
  const sizeBefore = await getFileSizeOrZero(file);
  await instance.query('VACUUM');
  const sizeAfter = await getFileSizeOrZero(file);
  return {
    name,
    size_before: sizeBefore,
    size_after: sizeAfter,
    space_reclaimed: sizeBefore - sizeAfter,
  };
};

export const runVacuum = async entityName => {
  log.database.info('Starting database VACUUM', {
    triggered_by: entityName,
    databases: allDatabases.map(d => d.name),
  });

  const databases = await Promise.all(allDatabases.map(database => vacuumSingleDatabase(database)));

  const totalReclaimed = databases.reduce((sum, d) => sum + d.space_reclaimed, 0);

  log.database.info('Database VACUUM completed', {
    triggered_by: entityName,
    total_reclaimed: totalReclaimed,
  });

  return { databases, totalReclaimed };
};

export const runAnalyze = async entityName => {
  log.database.info('Starting database ANALYZE', {
    triggered_by: entityName,
    databases: allDatabases.map(d => d.name),
  });

  await Promise.all(allDatabases.map(({ instance }) => instance.query('ANALYZE')));

  log.database.info('Database ANALYZE completed', {
    triggered_by: entityName,
  });
};
