/**
 * Preset classics for the analysis board: instant content for guests and
 * new accounts — the board + live engine work with no account and no
 * imports, so these give the eval bar, lines, and badges something real to
 * say. Each PGN is replay-verified by sample-games.test.ts (an illegal
 * move in a preset is a build-breaking bug, not a runtime surprise).
 */

export interface SampleGame {
  id: string;
  title: string;
  players: string;
  blurb: string;
  /** What to look for — shown after loading. */
  hint: string;
  pgn: string;
}

export const SAMPLE_GAMES: SampleGame[] = [
  {
    id: "opera",
    title: "The Opera Game",
    players: "Morphy vs Duke Karl & Count Isouard, Paris 1858",
    blurb: "The most famous attacking miniature ever played — development as a weapon.",
    hint: "Step through and watch the eval: every Morphy move develops with a threat. The queen sacrifice 16.Qb8+!! forces mate.",
    pgn: `[Event "Paris Opera"]
[Site "Paris"]
[Date "1858.11.02"]
[White "Morphy, Paul"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`,
  },
  {
    id: "immortal",
    title: "The Immortal Game",
    players: "Anderssen vs Kieseritzky, London 1851",
    blurb: "White gives up both rooks, the bishop, and the queen — and mates with the leftovers.",
    hint: "The engine hates half of these sacrifices — that is the point. Compare romantic chess with the eval bar's verdict.",
    pgn: `[Event "London casual"]
[Site "London"]
[Date "1851.06.21"]
[White "Anderssen, Adolf"]
[Black "Kieseritzky, Lionel"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`,
  },
  {
    id: "deepblue",
    title: "Spot the blunder",
    players: "Deep Blue vs Kasparov, New York 1997 (game 6)",
    blurb: "The world champion loses in 19 moves to one careless move order. Can you find where it went wrong?",
    hint: "One Black move lets White sacrifice a knight and win on the spot. Step through with the engine on — the eval collapses at 7...h6?? (8.Nxe6!).",
    pgn: `[Event "IBM Man-Machine"]
[Site "New York"]
[Date "1997.05.11"]
[White "Deep Blue"]
[Black "Kasparov, Garry"]
[Result "1-0"]

1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nd7 5. Ng5 Ngf6 6. Bd3 e6 7. N1f3 h6
8. Nxe6 Qe7 9. O-O fxe6 10. Bg6+ Kd8 11. Bf4 b5 12. a4 Bb7 13. Re1 Nd5
14. Bg3 Kc8 15. axb5 cxb5 16. Qd3 Bc6 17. Bf5 exf5 18. Rxe7 Bxe7 19. c4 1-0`,
  },
  {
    id: "legal",
    title: "Légal's trap",
    players: "de Légal vs Saint Brie, Paris 1750",
    blurb: "White leaves the queen hanging on purpose. Taking it loses to a three-piece mate.",
    hint: "After 5.Nxe5!, Black grabs the queen with 5...Bxd1?? and gets mated in two. The engine shows 5...dxe5 was fine for Black.",
    pgn: `[Event "Café de la Régence"]
[Site "Paris"]
[Date "1750.01.01"]
[White "Kermeur de Légal"]
[Black "Saint Brie"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0`,
  },
];
