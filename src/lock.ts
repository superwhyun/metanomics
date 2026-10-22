import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";

// The prototype permits exactly one worker process per database. SQLite transactions
// serialize writes, but by themselves do not serialize asynchronous nonce allocation.
export function acquireWorkerLock(database: string): () => void {
  const path = `${database}.worker.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          try {
            if (readFileSync(path, "utf8") === String(process.pid))
              unlinkSync(path);
          } catch {}
        }
      };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(owner) || owner <= 0)
        throw new Error(`Invalid worker lock: ${path}`);
      try {
        process.kill(owner, 0);
      } catch (probe: any) {
        if (probe.code === "ESRCH") {
          unlinkSync(path);
          continue;
        }
        throw probe;
      }
      throw new Error(
        `Another worker (PID ${owner}) owns ${database}; stop it before starting this process`,
      );
    }
  }
  throw new Error(`Could not acquire worker lock: ${path}`);
}
