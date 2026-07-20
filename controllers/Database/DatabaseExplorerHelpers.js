import { allDatabases } from '../../config/Database.js';

export const findDatabase = name => allDatabases.find(database => database.name === name);

export const unknownDatabaseMessage = () =>
  `Unknown database — one of: ${allDatabases.map(d => d.name).join(', ')}`;

export const listTableNames = async instance => {
  const [tables] = await instance.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return tables.map(table => table.name);
};

export const buildTableSummaries = async instance => {
  const names = await listTableNames(instance);
  const [indexes] = await instance.query(
    "SELECT name, tbl_name as 'table' FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return Promise.all(
    names.map(async name => {
      const [[countResult]] = await instance.query(`SELECT COUNT(*) as count FROM "${name}"`);
      return {
        name,
        rows: countResult.count,
        indexes: indexes.filter(index => index.table === name).map(index => index.name),
      };
    })
  );
};

export const fetchTableColumns = async (instance, table) => {
  const [columnsInfo] = await instance.query(`PRAGMA table_info("${table}")`);
  return columnsInfo.map(column => column.name);
};

export const buildOrderClause = (orderBy, columns) => {
  if (!orderBy) {
    return '';
  }
  const [orderColumn, direction = 'asc'] = String(orderBy).split(':');
  if (!columns.includes(orderColumn)) {
    return null;
  }
  const orderDirection = direction.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return ` ORDER BY "${orderColumn}" ${orderDirection}`;
};
