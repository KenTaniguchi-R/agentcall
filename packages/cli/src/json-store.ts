import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// Write beside the destination so rename stays on one filesystem. A unique
// temp name also lets concurrent CLI processes save without sharing a partial
// file. The destination is only replaced after serialization and writing both
// succeed.
export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// Recovery uses this stronger variant because the candidate token on disk is
// the only secret that can authenticate after the relay commits. Atomic rename
// prevents torn JSON; fsyncing both the inode and directory makes the rename
// survive a power loss before the network request is allowed to start.
export function writeJsonDurable(file: string, data: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function removeFileDurable(file: string): void {
  const dir = dirname(file);
  rmSync(file);
  const dirFd = openSync(dir, "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}
