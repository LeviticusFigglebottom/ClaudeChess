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
  private partitions = new Map<VariantId, { idle: ServerEngine[]; busy: number }>();
  private total = 0;
  private waiters: { variant: VariantId; resolve: (engine: ServerEngine) => void }[] = [];
  private closed = false;

  constructor(opts: { cap?: number; hashMb?: number } = {}) {
    this.cap = Math.max(1, opts.cap ?? 3);
    this.hashMb = opts.hashMb ?? 128;
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
        const engine = new ServerEngine(variant);
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
    return new Promise((resolve) => {
      this.waiters.push({ variant, resolve });
    });
  }

  private release(engine: ServerEngine): void {
    const partition = this.partition(engine.variant);
    partition.busy--;
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
        const fresh = new ServerEngine(other.variant);
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
