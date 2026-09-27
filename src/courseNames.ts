// Written by the site's scripts/course-names.mjs from its plans (src/games/hotlap/dailyPlan.ts and
// src/games/acechase/dailyPlan.ts): each planned Hot Lap track's name and each planned Ace Chase hole's, by
// day from each game's first, for the record books (records.ts), where each track's and each hole's record
// is named after it. The plan scripts write it again whenever they write a plan. Don't edit it by hand.

/** Hot Lap's tracks, the first day's (hotlapPace.ts HOTLAP_FIRST_DAY) first. */
export const HOTLAP_TRACK_NAMES: readonly string[] = [
  'The Classic', 'Pine Circuit', 'Seneca Glen', 'Willow Speedway', 'Lakeside Run', 'Juniper Circuit',
  'Thunder Loop', 'Coral Raceway', 'Canyon Run', 'Meadow Bends', 'Riverside Speedway', 'Bramble Speedway',
  'Riverside Park', 'Harbor Bends', 'Falcon Bends', 'Harvest Loop', 'Beacon Circuit', 'Summit Raceway',
  'Ember Run', 'Falcon Speedway', 'Moonlight Ring', 'Maple Speedway', 'Quarry Ring', 'Harbor Circuit',
  'Driftwood Loop', 'Glacier Park', 'Harbor Raceway', 'Copper Bends', 'Thunder Ring', 'Riverside Loop',
  'Orchard Bends', 'Ember Bends', 'Glacier Circuit', 'Orchard Loop', 'Meadow Speedway', 'Harbor Park',
  'Meadow Circuit', 'Quarry Raceway', 'Juniper Park', 'Willow Run', 'Maple Loop', 'Coral Circuit',
  'Orchard Ring', 'Bramble Raceway', 'Cedar Loop', 'Quarry Run', 'Aspen Raceway', 'Mesa Run',
  'Silver Loop', 'Lakeside Loop', 'Coral Run', 'Cedar Raceway', 'Summit Loop', 'Falcon Ring',
  'Lakeside Circuit', 'Orchard Speedway', 'Bramble Bends', 'Aspen Circuit', 'Willow Bends', 'Coral Speedway',
  'Canyon Park', 'Glacier Run', 'Beacon Loop', 'Harbor Ring', 'Pine Loop', 'Driftwood Bends',
  'Maple Park', 'Quarry Loop', 'Beacon Raceway', 'Silver Bends', 'Juniper Raceway', 'Quarry Speedway',
  'Juniper Speedway', 'Silver Raceway', 'Glacier Raceway', 'Mesa Bends', 'Sunset Raceway', 'Harbor Run',
  'Coral Loop', 'Lakeside Bends', 'Quarry Circuit', 'Sunset Park', 'Juniper Ring', 'Mesa Loop',
  'Canyon Bends', 'Granite Loop', 'Moonlight Speedway', 'Summit Ring', 'Thunder Park', 'Granite Circuit',
  'Juniper Loop', 'Ember Loop', 'Granite Ring', 'Beacon Ring', 'Willow Raceway', 'Summit Bends',
  'Riverside Bends', 'Driftwood Ring', 'Aspen Park', 'Bramble Run', 'Harvest Ring', 'Copper Speedway',
  'Kestrel Loop', 'Driftwood Run', 'Bramble Ring', 'Maple Raceway', 'Harvest Circuit', 'Mesa Ring',
  'Orchard Circuit', 'Silver Ring', 'Copper Circuit', 'Harbor Loop', 'Moonlight Loop', 'Harvest Raceway',
  'Kestrel Raceway', 'Mesa Raceway', 'Thunder Run', 'Willow Ring', 'Driftwood Speedway', 'Driftwood Park',
  'Meadow Run', 'Silver Circuit', 'Thunder Raceway', 'Kestrel Ring', 'Aspen Speedway', 'Mesa Park',
  'Falcon Loop', 'Moonlight Run', 'Maple Run', 'Falcon Run', 'Silver Speedway', 'Copper Loop',
  'Granite Raceway', 'Canyon Ring', 'Summit Park', 'Pine Speedway', 'Moonlight Raceway', 'Ember Raceway',
  'Kestrel Speedway', 'Granite Park', 'Riverside Circuit', 'Riverside Raceway', 'Summit Speedway', 'Sunset Run',
  'Ember Circuit', 'Harvest Park', 'Maple Circuit', 'Cedar Ring', 'Moonlight Bends', 'Mesa Circuit',
  'Orchard Park', 'Willow Loop', 'Falcon Circuit', 'Thunder Speedway', 'Copper Park', 'Canyon Loop',
  'Moonlight Circuit', 'Sunset Ring', 'Ember Speedway', 'Bramble Circuit', 'Granite Bends', 'Juniper Bends',
  'Canyon Raceway', 'Driftwood Raceway', 'Coral Park', 'Driftwood Circuit', 'Pine Bends', 'Aspen Run',
  'Harbor Speedway', 'Silver Park', 'Harvest Run', 'Summit Run', 'Coral Bends', 'Aspen Ring',
  'Glacier Loop', 'Quarry Park', 'Kestrel Park', 'Cedar Circuit', 'Silver Run', 'Sunset Bends',
  'Harvest Speedway',
]

/** Today's Hole #1 was this day's. */
export const ACECHASE_FIRST_DAY = '2026-09-25'

/** Ace Chase's holes, the first day's first. */
export const ACECHASE_HOLE_NAMES: readonly string[] = [
  'Primrose Dogleg', 'Primrose Steps', 'Blizzard Bumps', 'Foxglove Butte', 'Orchard Neck', 'Bramble Sands',
  'Meadow Flipper', 'Clover Terrace', 'Hailstone Lagoon', 'Lunar Plateau', 'Foxglove Pinball', 'Orchard Bunkers',
  'Hollyhock Steps', 'Hollyhock Gates', 'Primrose Waters', 'Tranquility Narrows', 'Primrose Butte', 'Hailstone Gates',
  'Hollyhock Steps', 'Clover Mesa', 'Orchard Knolls', 'Hollyhock Bunkers', 'Clover Lagoon', 'Bramble Elbow',
  'Clover Bumps', 'Willow Bumpers', 'Apollo Gates', 'Meadow Bend', 'Hollyhock Butte', 'Tranquility Flipper',
  'Primrose Dunes', 'Frost Steps', 'Foxglove Humps', 'Hollyhock Neck', 'Bramble Portcullis', 'Hollyhock Waters',
  'Foxglove Hourglass', 'Foxglove Flipper', 'Stardust Wall', 'Clover Tiers', 'Willow Plateau', 'Meadow Traps',
  'Hollyhock Bumps', 'Primrose Tabletop', 'Willow Pond', 'Selene Gates', 'Orchard Lagoon', 'Primrose Gaps',
  'Willow Bend', 'Meadow Neck', 'Primrose Mesa', 'Clover Bumpers', 'Blizzard Tabletop', 'Clover Bumps',
  'Bramble Portcullis', 'Willow Tiers', 'Meadow Elbow', 'Hollyhock Butte', 'Meadow Sands', 'Orchard Portcullis',
  'Glacier Neck', 'Bramble Bumpers', 'Clover Waters', 'Bramble Narrows', 'Foxglove Corner', 'Orchard Humps',
  'Glacier Plateau', 'Clover Tiers', 'Selene Lagoon', 'Meadow Ledge', 'Willow Flipper', 'Snowdrift Neck',
  'Meadow Lagoon', 'Stardust Flipper', 'Orchard Tabletop', 'Foxglove Terrace', 'Bramble Plateau', 'Clover Squeeze',
  'Willow Steps', 'Foxglove Knolls', 'Clover Traps', 'Orchard Tabletop', 'Clover Hillocks', 'Meadow Plateau',
  'Snowdrift Flipper', 'Meadow Humps', 'Moonbeam Gates', 'Clover Pond', 'Bramble Steps', 'Foxglove Plateau',
  'Orchard Humps', 'Hollyhock Dunes', 'Hollyhock Bend', 'Tranquility Bumpers', 'Bramble Steps', 'Willow Portcullis',
  'Foxglove Terrace', 'Orchard Plateau', 'Orbit Squeeze', 'Foxglove Tabletop', 'Orchard Arcade', 'Clover Waters',
  'Willow Tabletop', 'Frost Humps', 'Clover Corner', 'Primrose Traps', 'Willow Wall', 'Bramble Narrows',
  'Willow Ledge', 'Meadow Butte', 'Apollo Portcullis', 'Foxglove Butte', 'Clover Humps', 'Willow Neck',
  'Primrose Knolls', 'Clover Lagoon', 'Lunar Bumpers', 'Bramble Pond', 'Glacier Plateau', 'Primrose Squeeze',
  'Orchard Portcullis', 'Stardust Elbow', 'Willow Ledge', 'Orchard Dunes', 'Blizzard Hillocks', 'Meadow Arcade',
  'Clover Waters', 'Apollo Portcullis', 'Bramble Elbow', 'Hollyhock Sands', 'Meadow Squeeze', 'Primrose Bumpers',
  'Bramble Steps', 'Clover Plateau', 'Crater Hillocks', 'Icicle Hourglass', 'Bramble Dunes', 'Orchard Gates',
  'Bramble Bend', 'Primrose Butte', 'Orbit Bumps', 'Bramble Pool', 'Hailstone Tiers', 'Bramble Bumpers',
  'Meadow Elbow', 'Hollyhock Ledge', 'Primrose Bunkers', 'Primrose Pinball', 'Clover Pond', 'Orchard Tabletop',
  'Primrose Portcullis', 'Clover Narrows', 'Orchard Humps', 'Primrose Terrace', 'Bramble Tabletop', 'Primrose Pinball',
  'Orchard Hourglass', 'Snowdrift Humps', 'Tranquility Lagoon', 'Primrose Elbow', 'Meadow Terrace', 'Foxglove Portcullis',
  'Tranquility Pond', 'Hailstone Mesa', 'Orchard Hillocks', 'Bramble Flipper', 'Foxglove Humps', 'Meadow Dogleg',
  'Primrose Gaps', 'Apollo Terrace', 'Willow Dunes', 'Primrose Lagoon', 'Foxglove Knolls', 'Foxglove Dunes',
  'Frost Steps', 'Hollyhock Plateau', 'Willow Neck', 'Frost Portcullis', 'Meadow Bend', 'Clover Flipper',
]
