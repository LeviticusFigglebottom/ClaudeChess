import Link from "next/link";
import { HomeBoard } from "./home-board";

const FEATURES = [
  {
    href: "/play",
    title: "Play",
    body: "Calibrated bots from 600 to 2400, Chess960, live games with friends — every strength label is measured, not guessed.",
    accent: true,
  },
  {
    href: "/puzzles",
    title: "Puzzles",
    body: "Tactics generated from real games and rated against your solving history.",
  },
  {
    href: "/games",
    title: "Import & review",
    body: "Pull your chess.com and Lichess games, get depth-18 review with named blunder mechanisms — not just centipawns.",
  },
  {
    href: "/train/fingerprint",
    title: "Blunder fingerprint",
    body: "Which tactical motif do YOU miss most? Deterministic detectors over your own errors.",
  },
  {
    href: "/train/calibration",
    title: "Eval calibration",
    body: "Guess the eval, get scored against the engine — learn what winning actually looks like.",
  },
  {
    href: "/train/tempo",
    title: "Time allocation",
    body: "Where you burn clock and where you should — measured from your own games.",
  },
] as const;

export default function Home() {
  return (
    <div className="flex flex-col gap-12 py-4">
      <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-paper sm:text-5xl">
            Play chess.
            <br />
            <span className="text-accent">Find out why you lose.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-text-dim">
            GAMBIT is a full chess platform wrapped around a diagnostic instrument: calibrated
            bots, live play, puzzles — and trainers that name the actual mechanism behind every
            mistake you make.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/play" className="btn-primary text-base">
              Play now
            </Link>
            <Link href="/puzzles" className="btn-ghost text-base">
              Solve puzzles
            </Link>
            <Link href="/games" className="btn-ghost text-base">
              Analyze my games
            </Link>
          </div>
        </div>
        <div className="card mx-auto w-full max-w-[440px] p-3">
          <HomeBoard />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-text-faint">
          The instrument
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Link
              key={feature.href}
              href={feature.href}
              className={`card card-hover flex flex-col gap-2 p-5 ${
                "accent" in feature && feature.accent ? "border-accent/40" : ""
              }`}
            >
              <h3 className="text-lg font-semibold text-paper">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-text-dim">{feature.body}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
