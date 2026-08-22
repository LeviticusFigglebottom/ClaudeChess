import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <p className="notation text-6xl font-bold text-text-faint">404</p>
      <h1 className="text-xl font-semibold text-paper">This square is empty.</h1>
      <p className="max-w-sm text-sm text-text-dim">
        The page you were looking for doesn&apos;t exist — it may have been captured, or the
        link is stale.
      </p>
      <div className="mt-2 flex gap-3">
        <Link href="/" className="btn-primary text-sm">
          Back to the board
        </Link>
        <Link href="/games" className="btn-ghost text-sm">
          My games
        </Link>
      </div>
    </div>
  );
}
