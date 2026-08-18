import {
  loadStore,
  replaceAllBoards,
  replaceGameBoard,
  type GameSlug,
  type LeaderboardEntry,
} from './store.js'

type Row = [name: string, score: number, month: number, day: number, hour: number, minute: number]

/** Epoch ms for a 2026 America/New_York wall clock (EDT, UTC-4). */
function ny(month: number, day: number, hour: number, minute: number) {
  const sec = (day * 17 + minute * 3) % 60
  return Date.UTC(2026, month - 1, day, hour + 4, minute, sec)
}

function entry(name: string, score: number, at: number): LeaderboardEntry {
  const tag = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
  return {
    id: `${at}-${tag}${score}`,
    name,
    score,
    at,
    device: 'desktop',
  }
}

function board(rows: Row[]): LeaderboardEntry[] {
  return rows.map(([name, score, month, day, hour, minute]) =>
    entry(name, score, ny(month, day, hour, minute)),
  )
}

/** Sample arcade scores with dates that fill today / this week / this month / all-time. */
export function buildSeed() {
  return {
    stacker: board([
      // all-time legends (June–July)
      ['PIXEL', 91, 7, 19, 21, 33],
      ['JUNO', 88, 7, 8, 20, 4],
      ['BLAST', 79, 6, 27, 19, 48],
      // earlier this month
      ['JUNO', 86, 8, 3, 20, 55],
      ['PIXEL', 83, 8, 5, 19, 18],
      ['ACE', 77, 8, 2, 21, 7],
      ['MIX', 70, 8, 8, 15, 42],
      ['HALO', 63, 8, 6, 12, 11],
      ['PEBBLE', 52, 8, 4, 18, 3],
      ['MANGO', 44, 8, 7, 20, 29],
      ['TARO', 36, 8, 1, 17, 16],
      ['SAM', 24, 8, 9, 14, 8],
      // this week (Mon 10 – Thu 13)
      ['JUNO', 80, 8, 12, 20, 14],
      ['PIXEL', 74, 8, 10, 19, 2],
      ['BLAST', 66, 8, 11, 21, 44],
      ['GHOST', 58, 8, 13, 18, 30],
      ['NIBBLE', 47, 8, 11, 13, 22],
      ['KOI', 39, 8, 10, 16, 8],
      ['DUSK', 31, 8, 13, 22, 51],
      ['JESS', 25, 8, 12, 10, 40],
      ['OTTO', 16, 8, 11, 9, 12],
      // today (Fri 14)
      ['ACE', 72, 8, 14, 13, 41],
      ['KIT', 68, 8, 14, 14, 8],
      ['NOVA', 61, 8, 14, 12, 16],
      ['REX', 54, 8, 14, 11, 33],
      ['MOCHI', 49, 8, 14, 10, 2],
      ['ZAP', 41, 8, 14, 14, 20],
      ['HALO', 33, 8, 14, 9, 12],
      ['TARO', 28, 8, 14, 13, 5],
      ['WREN', 22, 8, 14, 8, 28],
      ['FIZZ', 18, 8, 14, 12, 48],
      ['BEE', 12, 8, 14, 8, 5],
    ]),
    patriot: board([
      ['BLAST', 17825, 7, 19, 21, 12],
      ['JUNO', 16950, 7, 8, 20, 28],
      ['PIXEL', 14100, 6, 27, 19, 6],
      ['JUNO', 16240, 8, 3, 20, 40],
      ['PIXEL', 15475, 8, 5, 19, 51],
      ['ACE', 13900, 8, 2, 21, 19],
      ['MIX', 11860, 8, 8, 15, 7],
      ['HALO', 9675, 8, 6, 12, 44],
      ['PEBBLE', 8090, 8, 4, 18, 21],
      ['MANGO', 6755, 8, 7, 20, 3],
      ['SAM', 4540, 8, 9, 14, 36],
      ['JUNO', 14820, 8, 12, 20, 40],
      ['PIXEL', 13110, 8, 10, 19, 28],
      ['BLAST', 10650, 8, 11, 21, 12],
      ['GHOST', 8925, 8, 13, 18, 5],
      ['NIBBLE', 7040, 8, 11, 14, 16],
      ['KOI', 5830, 8, 10, 17, 44],
      ['DUSK', 4100, 8, 13, 22, 20],
      ['JESS', 3025, 8, 12, 10, 55],
      ['OTTO', 1760, 8, 11, 9, 18],
      ['ACE', 11275, 8, 14, 13, 18],
      ['KIT', 9860, 8, 14, 14, 10],
      ['NOVA', 8440, 8, 14, 12, 5],
      ['REX', 7215, 8, 14, 11, 22],
      ['MOCHI', 6380, 8, 14, 10, 55],
      ['ZAP', 5125, 8, 14, 14, 21],
      ['HALO', 4290, 8, 14, 9, 8],
      ['TARO', 3475, 8, 14, 11, 33],
      ['WREN', 2610, 8, 14, 8, 50],
      ['FIZZ', 1985, 8, 14, 12, 7],
      ['BEE', 1240, 8, 14, 8, 22],
    ]),
    snake: board([
      ['PIXEL', 740, 7, 19, 21, 20],
      ['JUNO', 680, 7, 8, 20, 11],
      ['BLAST', 540, 6, 27, 19, 37],
      ['JUNO', 610, 8, 3, 20, 48],
      ['PIXEL', 560, 8, 5, 19, 9],
      ['ACE', 490, 8, 2, 21, 26],
      ['MIX', 430, 8, 8, 15, 14],
      ['HALO', 350, 8, 6, 12, 3],
      ['PEBBLE', 290, 8, 4, 18, 41],
      ['MANGO', 230, 8, 7, 20, 16],
      ['SAM', 140, 8, 9, 14, 52],
      ['JUNO', 520, 8, 12, 20, 6],
      ['PIXEL', 470, 8, 10, 19, 33],
      ['BLAST', 390, 8, 11, 21, 18],
      ['GHOST', 340, 8, 13, 18, 47],
      ['NIBBLE', 260, 8, 11, 13, 9],
      ['KOI', 200, 8, 10, 16, 21],
      ['DUSK', 160, 8, 13, 22, 4],
      ['JESS', 110, 8, 12, 10, 27],
      ['OTTO', 70, 8, 11, 9, 50],
      ['ACE', 410, 8, 14, 13, 6],
      ['KIT', 370, 8, 14, 14, 12],
      ['NOVA', 330, 8, 14, 12, 48],
      ['REX', 280, 8, 14, 11, 11],
      ['MOCHI', 250, 8, 14, 10, 37],
      ['ZAP', 210, 8, 14, 14, 20],
      ['HALO', 180, 8, 14, 9, 55],
      ['TARO', 150, 8, 14, 13, 28],
      ['WREN', 120, 8, 14, 8, 41],
      ['FIZZ', 90, 8, 14, 12, 33],
      ['BEE', 50, 8, 14, 8, 14],
    ]),
    'pop': board([
      ['PIXEL', 620, 7, 19, 21, 8],
      ['JUNO', 580, 7, 8, 20, 22],
      ['BLAST', 510, 6, 27, 19, 14],
      ['JUNO', 540, 8, 3, 20, 33],
      ['PIXEL', 500, 8, 5, 19, 41],
      ['ACE', 460, 8, 2, 21, 5],
      ['MIX', 410, 8, 8, 15, 18],
      ['HALO', 360, 8, 6, 12, 27],
      ['JUNO', 480, 8, 12, 20, 11],
      ['PIXEL', 440, 8, 10, 19, 55],
      ['BLAST', 390, 8, 11, 21, 3],
      ['GHOST', 340, 8, 13, 18, 16],
      ['ACE', 420, 8, 14, 13, 22],
      ['KIT', 380, 8, 14, 14, 4],
      ['NOVA', 350, 8, 14, 12, 11],
      ['REX', 310, 8, 14, 11, 48],
      ['MOCHI', 280, 8, 14, 10, 19],
      ['ZAP', 250, 8, 14, 14, 28],
      ['HALO', 220, 8, 14, 9, 36],
      ['TARO', 190, 8, 14, 13, 9],
      ['WREN', 160, 8, 14, 8, 44],
      ['FIZZ', 130, 8, 14, 12, 2],
      ['BEE', 90, 8, 14, 8, 17],
    ]),
    'dead-center': board([
      // all-time legends (June–July) — 5 rounds, ~1000 max each
      ['PIXEL', 4120, 7, 19, 21, 15],
      ['JUNO', 3890, 7, 8, 20, 28],
      ['BLAST', 3510, 6, 27, 19, 22],
      // earlier this month
      ['JUNO', 3720, 8, 3, 20, 40],
      ['PIXEL', 3480, 8, 5, 19, 12],
      ['ACE', 3290, 8, 2, 21, 8],
      ['MIX', 2910, 8, 8, 15, 25],
      ['HALO', 2540, 8, 6, 12, 27],
      ['PEBBLE', 2180, 8, 4, 18, 21],
      ['MANGO', 1840, 8, 7, 20, 3],
      ['TARO', 1510, 8, 1, 17, 16],
      ['SAM', 980, 8, 9, 14, 36],
      // this week (Mon 10 – Sat 15)
      ['JUNO', 3380, 8, 12, 20, 18],
      ['PIXEL', 3120, 8, 10, 19, 44],
      ['BLAST', 2760, 8, 11, 21, 3],
      ['GHOST', 2410, 8, 13, 18, 16],
      ['NIBBLE', 1980, 8, 11, 13, 9],
      ['KOI', 1650, 8, 10, 16, 21],
      ['DUSK', 1320, 8, 13, 22, 4],
      ['JESS', 1040, 8, 12, 10, 27],
      ['OTTO', 710, 8, 15, 9, 50],
      // today (Sun 16)
      ['ACE', 2840, 8, 16, 13, 10],
      ['KIT', 2610, 8, 16, 14, 6],
      ['NOVA', 2380, 8, 16, 12, 22],
      ['REX', 2090, 8, 16, 11, 38],
      ['MOCHI', 1870, 8, 16, 10, 14],
      ['ZAP', 1620, 8, 16, 14, 30],
      ['HALO', 1390, 8, 16, 9, 48],
      ['TARO', 1160, 8, 16, 13, 16],
      ['WREN', 940, 8, 16, 8, 52],
      ['FIZZ', 720, 8, 16, 12, 8],
      ['BEE', 480, 8, 16, 8, 24],
    ]),
    asteroids: board([
      ['PIXEL', 6840, 7, 19, 21, 18],
      ['JUNO', 6120, 7, 8, 20, 33],
      ['BLAST', 5480, 6, 27, 19, 11],
      ['JUNO', 5760, 8, 3, 20, 44],
      ['PIXEL', 5210, 8, 5, 19, 22],
      ['ACE', 4680, 8, 2, 21, 16],
      ['MIX', 4020, 8, 8, 15, 28],
      ['HALO', 3440, 8, 6, 12, 40],
      ['PEBBLE', 2890, 8, 4, 18, 9],
      ['MANGO', 2410, 8, 7, 20, 14],
      ['TARO', 1980, 8, 1, 17, 33],
      ['SAM', 1320, 8, 9, 14, 41],
      ['JUNO', 4920, 8, 12, 20, 8],
      ['PIXEL', 4460, 8, 10, 19, 36],
      ['BLAST', 3810, 8, 11, 21, 19],
      ['GHOST', 3260, 8, 13, 18, 27],
      ['NIBBLE', 2680, 8, 11, 13, 14],
      ['KOI', 2210, 8, 10, 16, 48],
      ['DUSK', 1740, 8, 13, 22, 11],
      ['JESS', 1290, 8, 12, 10, 33],
      ['OTTO', 860, 8, 15, 9, 22],
      ['ACE', 4180, 8, 16, 13, 18],
      ['KIT', 3720, 8, 16, 14, 4],
      ['NOVA', 3290, 8, 16, 12, 28],
      ['REX', 2840, 8, 16, 11, 41],
      ['MOCHI', 2460, 8, 16, 10, 9],
      ['ZAP', 2080, 8, 16, 14, 33],
      ['HALO', 1710, 8, 16, 9, 52],
      ['TARO', 1390, 8, 16, 13, 16],
      ['WREN', 1080, 8, 16, 8, 40],
      ['FIZZ', 790, 8, 16, 12, 11],
      ['BEE', 520, 8, 16, 8, 28],
    ]),
    simon: board([
      ['PIXEL', 18, 7, 19, 21, 12],
      ['JUNO', 16, 7, 8, 20, 18],
      ['BLAST', 14, 6, 27, 19, 9],
      ['JUNO', 15, 8, 3, 20, 41],
      ['PIXEL', 13, 8, 5, 19, 22],
      ['ACE', 12, 8, 2, 21, 7],
      ['MIX', 11, 8, 8, 15, 14],
      ['HALO', 10, 8, 6, 12, 31],
      ['JUNO', 12, 8, 12, 20, 8],
      ['PIXEL', 11, 8, 10, 19, 48],
      ['BLAST', 9, 8, 11, 21, 2],
      ['GHOST', 8, 8, 13, 18, 19],
      ['ACE', 10, 8, 14, 13, 16],
      ['KIT', 9, 8, 14, 14, 5],
      ['NOVA', 8, 8, 14, 12, 21],
      ['REX', 7, 8, 14, 11, 38],
      ['MOCHI', 6, 8, 14, 10, 11],
      ['ZAP', 6, 8, 14, 14, 27],
      ['HALO', 5, 8, 14, 9, 44],
      ['TARO', 5, 8, 14, 13, 8],
      ['WREN', 4, 8, 14, 8, 36],
      ['FIZZ', 4, 8, 14, 12, 14],
      ['BEE', 3, 8, 14, 8, 19],
    ]),
  }
}

const PLACEHOLDER_NAME = /^(ME2?|TEST|YOU|RAMSEY-TEST\d*)$/

export function isPlaceholderStore() {
  const store = loadStore()
  const entries = [
    ...store.stacker,
    ...store.patriot,
    ...store.snake,
    ...(store['pop'] ?? []),
    ...(store['dead-center'] ?? []),
    ...(store.asteroids ?? []),
    ...(store.simon ?? []),
  ]
  if (entries.length === 0) return true
  return entries.every((e) => PLACEHOLDER_NAME.test(e.name))
}

export function seedLeaderboards(force = false) {
  if (!force && !isPlaceholderStore()) return false
  replaceAllBoards(buildSeed())
  return true
}

export function seedGame(game: GameSlug) {
  const entries = buildSeed()[game]
  if (!entries) return false
  replaceGameBoard(game, entries)
  return true
}
