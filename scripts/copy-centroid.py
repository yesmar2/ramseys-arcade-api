"""
Copy Centroid's daily plan and scoring from the site (ramseys-arcade/src/games/dead-center) into src/centroid,
byte for byte but for their imports, so the API deals the same day's plates and scores six taps to the same
figure. Run from this repo after changing any of them on the site: python scripts/copy-centroid.py, then
`npm run check:centroid`.
"""
import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
API = os.path.join(HERE, '..', 'src', 'centroid')
WEB = os.path.join(HERE, '..', '..', 'ramseys-arcade', 'src')

FILES = {
    'games/dead-center/plates.ts': 'plates.ts',
    'games/dead-center/plan.ts': 'plan.ts',
    'games/dead-center/score.ts': 'score.ts',
    'games/dead-center/boardFigure.ts': 'boardFigure.ts',
    'lib/seededRandom.ts': 'seededRandom.ts',
}

HEADER = """/*
 * A copy of the site's src/{src} (ramseys-arcade), kept identical but for its imports, so the API deals the
 * same day of plates and scores six taps to the same figure. Change both together (scripts/copy-centroid.py);
 * `npm run check:centroid` compares them day by day.
 */

"""

os.makedirs(API, exist_ok=True)
for src, dst in FILES.items():
    text = io.open(os.path.join(WEB, src), encoding='utf-8').read()
    text = text.replace("from '../../lib/seededRandom'", "from './seededRandom.js'")
    text = re.sub(r"from '\./([A-Za-z]+)'", r"from './\1.js'", text)
    io.open(os.path.join(API, dst), 'w', encoding='utf-8', newline='\n').write(HEADER.format(src=src) + text)
print('copied', len(FILES), 'files to src/centroid')
