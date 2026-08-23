"use client";

import Link from "next/link";
import { useFlag } from "@/components/use-flag";
import type { FeatureFlag } from "@/lib/flags";

/**
 * §9 trainer hub. Every trainer ships behind its flag, default off — the
 * Labs section in settings turns them on per user (or env-wide).
 */
const TRAINERS: {
  flag: FeatureFlag;
  href: string;
  name: string;
  claim: string;
}[] = [
  {
    flag: "FF_CALIBRATION",
    href: "/train/calibration",
    name: "Eval calibration",
    claim: "Knowing whether you're better is the 1200→1800 skill — train it directly.",
  },
  {
    flag: "FF_FINGERPRINT",
    href: "/train/fingerprint",
    name: "Blunder fingerprint",
    claim: "Not \"you blundered 4 times\" — which mechanism, how often, and is it shrinking.",
  },
  {
    flag: "FF_TEMPO",
    href: "/train/tempo",
    name: "Time allocation",
    claim: "Your accuracy is flat past ~15s on routine moves. Find your flat point; stop paying past it.",
  },
  {
    flag: "FF_REPERTOIRE",
    href: "/train/repertoire",
    name: "Repertoire EV",
    claim: "Points per 100 games per memorized move — learn the 4 moves that matter, not 15 into the Najdorf.",
  },
  {
    flag: "FF_POSTMORTEM",
    href: "/train/postmortem",
    name: "Post-mortem",
    claim: "Right move, wrong reason — invisible to every tool that only sees the move.",
  },
];

export function TrainHub() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-1 text-2xl font-bold text-paper">Train</h1>
      <p className="mb-1 text-sm text-text-faint">
        Diagnostic instruments over your own games — import and analyze a few games and every trainer lights up.
      </p>
      <p className="mb-5 text-sm text-text-faint">
        New here? Start with{" "}
        <Link href="/puzzles" className="text-brilliant hover:underline">
          themed puzzle decks
        </Link>{" "}
        or{" "}
        <Link href="/analysis" className="text-brilliant hover:underline">
          the classics on the analysis board
        </Link>{" "}
        — both work without any games of your own.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {TRAINERS.map((trainer) => (
          <TrainerCard key={trainer.flag} {...trainer} />
        ))}
      </div>
    </div>
  );
}

function TrainerCard({ flag, href, name, claim }: (typeof TRAINERS)[number]) {
  const on = useFlag(flag);
  return (
    <div className={`card p-5 ${on ? "card-hover" : "opacity-60"}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-paper">{name}</h2>
        <span className={`notation text-xs ${on ? "text-brilliant" : "text-text-faint"}`}>
          {on ? "on" : "off"}
        </span>
      </div>
      <p className="mb-3 text-sm text-text-dim">{claim}</p>
      {on ? (
        <Link href={href} className="btn-primary px-4 py-1.5 text-sm">
          Open
        </Link>
      ) : (
        <p className="text-xs text-text-faint">Disabled on this deployment.</p>
      )}
    </div>
  );
}
