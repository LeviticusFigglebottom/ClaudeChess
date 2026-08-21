/**
 * Glicko-2 (spec §7), implemented straight from Glickman's paper
 * (http://www.glicko.net/glicko/glicko2.pdf), steps 1–8.
 *
 * Params per spec: τ = 0.5, initial rating 1500, RD 350, volatility 0.06.
 * Ratings update in batches per rating period (12 games or 7 days, whichever
 * first — enforced by the caller, Phase 1); per-game updates would defeat the
 * estimator. Bots carry fixed rating with RD 30 so they inform the user's
 * rating without drifting.
 */

export const TAU = 0.5;
export const INITIAL_RATING = 1500;
export const INITIAL_RD = 350;
export const INITIAL_VOLATILITY = 0.06;
export const BOT_RD = 30;

/** Glicko-2 scale conversion constant. */
const SCALE = 173.7178;
const CONVERGENCE = 1e-6;

export interface Glicko2Rating {
  rating: number;
  rd: number;
  volatility: number;
}

export interface GameResult {
  opponentRating: number;
  opponentRd: number;
  /** 1 = win, 0.5 = draw, 0 = loss (from the rated player's perspective). */
  score: number;
}

export function newPlayerRating(): Glicko2Rating {
  return { rating: INITIAL_RATING, rd: INITIAL_RD, volatility: INITIAL_VOLATILITY };
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Applies one rating period. With an empty result set, only the RD grows
 * (paper step 6 note): φ' = sqrt(φ² + σ²).
 */
export function updateRating(
  player: Glicko2Rating,
  results: GameResult[],
  tau: number = TAU
): Glicko2Rating {
  const mu = (player.rating - INITIAL_RATING) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.volatility;

  if (results.length === 0) {
    const phiPrime = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: player.rating, rd: phiPrime * SCALE, volatility: sigma };
  }

  const opponents = results.map((r) => ({
    muJ: (r.opponentRating - INITIAL_RATING) / SCALE,
    phiJ: r.opponentRd / SCALE,
    score: r.score,
  }));

  // Step 3: estimated variance of the player's rating from game outcomes.
  let vInverse = 0;
  for (const { muJ, phiJ } of opponents) {
    const E = expectedScore(mu, muJ, phiJ);
    vInverse += g(phiJ) * g(phiJ) * E * (1 - E);
  }
  const v = 1 / vInverse;

  // Step 4: estimated improvement Δ.
  let outcomeSum = 0;
  for (const { muJ, phiJ, score } of opponents) {
    outcomeSum += g(phiJ) * (score - expectedScore(mu, muJ, phiJ));
  }
  const delta = v * outcomeSum;

  // Step 5: new volatility via the Illinois algorithm.
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const phiSqPlusV = phi * phi + v;
    return (
      (ex * (delta * delta - phiSqPlusV - ex)) / (2 * (phiSqPlusV + ex) * (phiSqPlusV + ex)) -
      (x - a) / (tau * tau)
    );
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaPrime = Math.exp(A / 2);

  // Step 6–7: new rating deviation and rating.
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * outcomeSum;

  // Step 8: back to the Glicko scale.
  return {
    rating: muPrime * SCALE + INITIAL_RATING,
    rd: phiPrime * SCALE,
    volatility: sigmaPrime,
  };
}
