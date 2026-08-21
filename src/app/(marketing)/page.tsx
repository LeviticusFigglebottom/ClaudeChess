import Link from "next/link";

const PHASES = [
  { name: "Phase 0 — Skeleton + engine", status: "done" },
  { name: "Phase 0.5 — Variants, schema, rules engine", status: "done" },
  { name: "Phase 1 — Play vs bot (standard + Chess960)", status: "current" },
  { name: "Phase 2 — Import + review pipeline", status: "planned" },
  { name: "Phase 3 — Puzzles + explorer", status: "planned" },
  { name: "Phase 4 — Multiplayer", status: "planned" },
  { name: "Phase 5 — The trainers", status: "planned" },
] as const;

export default function Home() {
  return (
    <div className="flex flex-col items-start gap-10 py-10">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight text-paper">
          The clone is infrastructure.
          <br />
          <span className="text-lcd">The trainers are the point.</span>
        </h1>
        <p className="mt-4 max-w-xl text-text-dim">
          A diagnostic instrument for your own play. Board, engine, and review are wired from
          boring libraries so five trainers that exist nowhere else can be built on top:
          eval calibration, blunder fingerprinting, time allocation, repertoire EV,
          interrogative post-mortem.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            href="/play"
            className="rounded-lg bg-paper px-5 py-2.5 font-medium text-field hover:bg-white-adv"
          >
            Play
          </Link>
          <Link
            href="/engine-check"
            className="rounded-lg border border-edge-strong px-5 py-2.5 font-medium text-text-dim hover:border-lcd hover:text-text"
          >
            Run engine check
          </Link>
        </div>
      </div>

      <div className="w-full max-w-xl">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-text-faint">
          Build status
        </h2>
        <ul className="space-y-2">
          {PHASES.map((phase) => (
            <li key={phase.name} className="flex items-center gap-3 text-sm">
              <span
                className={`notation w-4 text-center ${
                  phase.status === "done"
                    ? "text-lcd"
                    : phase.status === "current"
                      ? "text-paper"
                      : "text-text-faint"
                }`}
              >
                {phase.status === "done" ? "✓" : phase.status === "current" ? "▸" : "·"}
              </span>
              <span
                className={
                  phase.status === "current"
                    ? "text-text"
                    : phase.status === "done"
                      ? "text-text-dim"
                      : "text-text-faint"
                }
              >
                {phase.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
