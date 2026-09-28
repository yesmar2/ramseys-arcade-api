/*
 * A copy of the site's src/games/halffull/boardFigure.ts (ramseys-arcade), kept identical but for its imports, so the API builds
 * the same day of glasses and scores a pour to the same figure. Change both together;
 * `npm run check:halffull` compares them day by day.
 */

/*
 * Half Full's board figure on its own, so the boards and record books everywhere can show "91.5%" without
 * loading the game's glasses and day plans with it (score.ts works the figure out; these only show it).
 */

/**
 * The board's figure: hundredths of a point, rounded down like the day as it's shown, so the board never
 * reads a tenth more than the player's own card (9156 is 91.5%).
 */
export function boardScore(day: number): number {
  return Math.floor(100 * day + 1e-6)
}

/** A board figure as the board shows it: "91.5%". */
export function formatBoard(board: number): string {
  return `${(Math.floor(board / 10) / 10).toFixed(1)}%`
}
