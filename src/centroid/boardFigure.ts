/*
 * A copy of the site's src/games/dead-center/boardFigure.ts (ramseys-arcade), kept identical but for its imports, so the API deals the
 * same day of plates and scores six taps to the same figure. Change both together (scripts/copy-centroid.py);
 * `npm run check:centroid` compares them day by day.
 */

/*
 * Centroid's board figure on its own, so the boards and record books everywhere can show "93.4%" without
 * loading the game's plates with it (score.ts works the figure out; these only show it).
 */

/**
 * The board's figure: hundredths of a point, rounded down like the day as it's shown, so the board never
 * reads a tenth more than the player's own card (9346 is 93.4%).
 */
export function boardScore(day: number): number {
  return Math.floor(100 * day + 1e-6)
}

/** A board figure as the board shows it: "93.4%". */
export function formatBoard(board: number): string {
  return `${(Math.floor(board / 10) / 10).toFixed(1)}%`
}
