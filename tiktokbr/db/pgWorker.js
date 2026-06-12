import fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { Client } from 'pg';

const client = new Client(workerData.clientOptions || {});
let connectPromise = null;

function connectClient() {
  if (!connectPromise) connectPromise = client.connect();
  return connectPromise;
}

parentPort.on('message', async (message) => {
  const { sql, values, resultFile, sab } = message || {};
  const state = new Int32Array(sab);

  try {
    await connectClient();
    const result = await client.query(sql, values || []);
    fs.writeFileSync(resultFile, JSON.stringify({
      ok: true,
      rows: result.rows || [],
      rowCount: result.rowCount || 0,
    }));
  } catch (err) {
    fs.writeFileSync(resultFile, JSON.stringify({
      ok: false,
      error: err?.message || String(err),
    }));
  } finally {
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0, 1);
  }
});
