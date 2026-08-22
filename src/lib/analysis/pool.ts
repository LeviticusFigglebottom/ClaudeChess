import { ServerEngine } from "@/lib/engine/server";
import type { VariantId } from "@/lib/chess/variant";

/**
 * Variant-partitioned server engine pool (B0.2). UCI_Chess960 is a
 * per-instance option, so a mixed standard+960 batch on one pool would
 * thrash re-initializing — instead the queue partitions by variant with one
 * sub-pool per active variant, capped in total. When the cap is reached and
 * a new variant needs a slot, an idle engine from another partition is
 * retired and respawned for the requesting variant.
 */
export class AnalysisPool {
  private readonly cap: number;
  private readonly hashMb: number;
  /** Test hook: forwarded to every spawned engine (synthetic-hang tests). */
  private readonly engineOpts: { enginePath?: string };
  private partitions = new Map<VariantId, { idle: ServerEngine[]; busy: number }>();
  private total = 0;
  private waiters: {
    variant: VariantId;
    resolve: (engine: ServerEngine) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private closed = false;

  constructor(opts: { cap?: number; hashMb?: number; enginePath?: string } = {}) {
    this.cap = Math.max(1, opts.cap ?? 3);
    this.hashMb = opts.hashMb ?? 128;
    this.engineOpts = opts.enginePath ? { enginePath: opts.enginePath } : {};
  }

  async withEngine<T>(variant: VariantId, fn: (engine: ServerEngine) => Promise<T>): Promise<T> {
    const engine = await this.acquire(variant);
    try {
      return await fn(engine);
    } finally {
      this.release(engine);
    }
  }

  private partition(variant: VariantId) {
    let partition = this.partitions.get(variant);
    if (!partition) {
      partition = { idle: [], busy: 0 };
      this.partitions.set(variant, partition);
    }
    return partition;
  }

  private async acquire(variant: VariantId): Promise<ServerEngine> {
    if (this.closed) throw new Error("pool is shut down");
    const partition = this.partition(variant);
    const idle = partition.idle.pop();
    if (idle) {
      partition.busy++;
      return idle;
    }
    if (this.total < this.cap) {
      this.total++;
      partition.busy++;
      try {
        const engine = new ServerEngine(variant, this.engineOpts);
        await engine.init({ hashMb: this.hashMb });
        return engine;
      } catch (error) {
        this.total--;
        partition.busy--;
        throw error;
      }
    }
    // Cap reached: retire an idle engine from another partition if any.
    for (const [other, otherPartition] of this.partitions) {
      if (other === variant) continue;
      const victim = otherPartition.idle.pop();
      if (victim) {
        victim.quit();
        this.total--;
        return this.acquire(variant);
      }
    }
    // Everything busy: wait for a release of this variant (or any, which
    // frees a slot for retirement).
    return new Promise((resolve, reject) => {
      this.waiters.push({ variant, resolve, reject });
    });
  }

  private release(engine: ServerEngine): void {
    const partition = this.partition(engine.variant);
    partition.busy--;
    // Watchdog policy (§3.3): a dead engine (killed mid-wedge) is gone, and
    // a worker that soft-breached its budget three times this session is
    // retired — chronic slowness is a degraded worker, not bad luck. Either
    // way the slot frees up; a fresh engine spawns for any waiter.
    if (engine.dead || engine.softBreaches >= 3) {
      if (!engine.dead) engine.quit();
      this.total--;
      const waiter = this.waiters.shift();
      if (waiter) {
        void (async () => {
          this.total++;
          this.partition(waiter.variant).busy++;
          try {
            const fresh = new ServerEngine(waiter.variant, this.engineOpts);
            await fresh.init({ hashMb: this.hashMb });
            waiter.resolve(fresh);
          } catch (error) {
            this.total--;
            this.partition(waiter.variant).busy--;
            waiter.reject(error);
          }
        })();
      }
      return;
    }
    // Serve a same-variant waiter directly.
    const index = this.waiters.findIndex((waiter) => waiter.variant === engine.variant);
    if (index !== -1) {
      const [waiter] = this.waiters.splice(index, 1);
      partition.busy++;
      waiter!.resolve(engine);
      return;
    }
    // A waiter for a different variant: retire this engine, spawn theirs.
    const other = this.waiters.shift();
    if (other) {
      engine.quit();
      this.total--;
      void (async () => {
        this.total++;
        this.partition(other.variant).busy++;
        const fresh = new ServerEngine(other.variant, this.engineOpts);
        await fresh.init({ hashMb: this.hashMb });
        other.resolve(fresh);
      })();
      return;
    }
    partition.idle.push(engine);
  }

  shutdown(): void {
    this.closed = true;
    for (const partition of this.partitions.values()) {
      for (const engine of partition.idle) engine.quit();
      partition.idle = [];
    }
  }
}
