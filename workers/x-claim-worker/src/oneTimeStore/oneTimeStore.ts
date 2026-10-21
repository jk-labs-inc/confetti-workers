import { DurableObject } from "cloudflare:workers";
import type { OneTimeKind, StoredRecord } from "./types";

const RECORD_KEY = "record";

export class OneTimeStore extends DurableObject<Env> {
  async put(value: unknown, ttlSeconds: number): Promise<number> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.ctx.storage.kv.put<StoredRecord>(RECORD_KEY, { value, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
    return expiresAt;
  }

  async take(): Promise<unknown> {
    const record = this.ctx.storage.kv.get<StoredRecord>(RECORD_KEY);
    if (!record) return null;
    this.ctx.storage.kv.delete(RECORD_KEY);
    await this.ctx.storage.deleteAlarm();
    return Date.now() < record.expiresAt ? record.value : null;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export const oneTimeStub = (env: Env, kind: OneTimeKind, key: string) =>
  env.ONE_TIME_STORE.getByName(`${kind}:${key}`);
