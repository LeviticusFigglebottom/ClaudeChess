import Link from "next/link";

const PHASES = [
  { name: "Phase 0 — Skeleton + engine", status: "current" },
  { name: "Phase 1 — Play vs bot", status: "next" },
  { name: "Phase 2 — Import + review pipeline", status: "planned" },
  { name: "Phase 3 — Puzzles + explorer", status: "planned" },
  { name: "Phase 4 — Multiplayer", status: "planned" },
  { name: "Phase 5 — The trainers", status: "planned" },
] as const;

export default function Home() {
  return (
    <div className="flex flex-col items-start gap-10 py-10">
      <div>
        <h1 className="text-4xl font-bold tracking-tight">
          The clone is infrastructure.
          <br />
          <span className="text-amber-400">The trainers are the point.</span>
        </h1>
        <p className="mt-4 max-w-xl text-zinc-400">
          Board, engine, matchmaking, review — solved problems, wired from boring libraries. They
          exist here so five trainers that exist nowhere else can be built on top: eval
          calibration, blunder fingerprinting, time allocation, repertoire EV, interrogative
          post-mortem.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            href="/play"
            className="rounded-lg bg-amber-400 px-5 py-2.5 font-medium text-zinc-950 hover:bg-amber-300"
          >
            Play on the board
          </Link>
          <Link
            href="/engine-check"
            className="rounded-lg border border-zinc-700 px-5 py-2.5 font-medium text-zinc-300 hover:border-zinc-500"
          >
            Run engine check
          </Link>
        </div>
      </div>

      <div className="w-full max-w-xl">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Build status
        </h2>
        <ul className="space-y-2">
          {PHASES.map((phase) => (
            <li key={phase.name} className="flex items-center gap-3 text-sm">
              <span
                className={`h-2 w-2 rounded-full ${
                  phase.status === "current" ? "bg-amber-400" : "bg-zinc-700"
                }`}
              />
              <span className={phase.status === "current" ? "text-zinc-200" : "text-zinc-500"}>
                {phase.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
