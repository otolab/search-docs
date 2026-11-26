import { DBEngine } from '@search-docs/db-engine';

let db;

process.on('message', async ({ id, command, args }) => {
  try {
    let value;
    if (command === 'connect') {
      db = new DBEngine({ dbPath: args.dbPath });
      await db.connect({ skipInitModel: true });
    } else if (command === 'write-heartbeat') {
      if (!db) throw new Error('DBEngine is not connected');
      await db.claimWriter({ writerId: args.writerId, host: 'remote-test', pid: process.pid });
      await db.updateHeartbeat({
        writerId: args.writerId,
        host: 'remote-test',
        pid: process.pid,
        state: 'watching',
      });
      const result = await db.getWriterHeartbeat();
      if (!result.heartbeat) throw new Error('Writer heartbeat was not persisted');
      value = { timeZone: process.env.TZ, updatedAt: result.heartbeat.updatedAt };
    } else if (command === 'stop') {
      await db?.disconnect();
      db = undefined;
      process.send?.({ id, value: null }, () => process.exit(0));
      return;
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
    process.send?.({ id, value });
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
