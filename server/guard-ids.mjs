/**
 * Fails if either banned id pattern reappears.
 *
 * Both of these were removed wholesale, and both fail silently rather than
 * loudly, which is why a guard is worth more here than a comment:
 *
 *   String(a) === String(b)   two missing ids compare equal ("undefined"),
 *                             so an authorization check passes instead of
 *                             throwing. Use sameId(a, b), which fails closed.
 *
 *   map.get(String(x))        a missing id collapses to the literal key
 *                             "undefined", so every row lands on one bucket
 *                             and the numbers come out wrong with no error.
 *                             Use idOf(x).
 *
 * Run: npm run guard:ids
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOTS = ['src'];
/* utils/ids.js is where the pattern is documented and deliberately quoted. */
const EXEMPT = ['src/utils/ids.js'];

const BANNED = [
  {
    what: 'String(a) === String(b) — use sameId(a, b)',
    re: /String\((?:[^()]|\([^()]*\))*\)\s*[!=]==\s*String\(/,
  },
  {
    what: 'String(id) as a lookup key — use idOf(id)',
    /* The closing bracket matters: String(name).toUpperCase() as a key is
       ordinary text handling, not an id, and must not be flagged. */
    re: /(?:\.(?:get|set|has|add)\(|\[)String\((?:[^()]|\([^()]*\))*\)\s*[,)\]]/,
  },
];

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.js')) files.push(path.split(sep).join('/'));
  }
};
ROOTS.forEach(walk);

let found = 0;
for (const file of files) {
  if (EXEMPT.includes(file)) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const { what, re } of BANNED) {
        if (re.test(line)) {
          console.error(`  ${file}:${i + 1}  ${what}\n    ${line.trim()}`);
          found += 1;
        }
      }
    });
}

if (found) {
  console.error(`\n${found} banned id pattern(s) found — see server/src/utils/ids.js.`);
  process.exit(1);
}
console.log(`ok   no banned id patterns in ${files.length} files`);
