import { test, expect } from './fixtures';

/**
 * WCAG contrast gate over the design tokens. Text pairs must reach 4.5:1 (AA, small text),
 * in whichever theme the project is running. Runs once per theme (desktop projects only);
 * widths don't change colours.
 */

type Rgb = [number, number, number];

function parse(hex: string): { rgb: Rgb; a: number } {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], a: full.length === 8 ? n(6) / 255 : 1 };
}

/** Composite a possibly translucent colour over an opaque background. */
function over(fg: string, bg: string): Rgb {
  const f = parse(fg);
  const b = parse(bg).rgb;
  return f.rgb.map((c, i) => Math.round(c * f.a + b[i] * (1 - f.a))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground token, background token, what it is]
const TEXT_PAIRS: [string, string, string][] = [
  ['--foreground', '--background', 'body text on page'],
  ['--foreground', '--card', 'body text on card'],
  ['--text-2', '--background', 'secondary text on page'],
  ['--text-2', '--card', 'secondary text on card'],
  ['--muted-foreground', '--background', 'muted text on page'],
  ['--muted-foreground', '--card', 'muted text on card'],
  ['--muted-foreground', '--muted', 'muted text on alt band'],
  ['--accent-text', '--background', 'accent text on page'],
  ['--accent-text', '--card', 'accent text on card'],
  ['--accent-text', '--accent-tint', 'active chip text (tint over card)'],
  ['--income', '--card', 'money-in text on card'],
  ['--income', '--plum-tint', 'income chip text (tint over card)'],
  ['--destructive', '--background', 'problem text on page'],
  ['--destructive', '--card', 'problem text on card'],
  ['--primary-foreground', '--primary', 'text on amber button'],
  ['--popover-foreground', '--popover', 'popover text'],
  ['--sidebar-foreground', '--sidebar', 'sidebar text'],
  ['--muted-foreground', '--sidebar', 'sidebar muted text'],
];

test('design tokens meet WCAG AA for text', async ({ page, theme }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'colours do not change with width');
  await page.goto('/login');

  const tokens = await page.evaluate(
    names => {
      const cs = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(n).trim()]));
    },
    [...new Set(TEXT_PAIRS.flatMap(([a, b]) => [a, b]))]
  );

  const failures: string[] = [];
  for (const [fgToken, bgToken, what] of TEXT_PAIRS) {
    // Translucent surfaces (chip tints) sit on the card colour.
    const base = ['--accent-tint', '--plum-tint'].includes(bgToken)
      ? tokens['--card']
      : tokens[bgToken];
    const bg = over(tokens[bgToken], base);
    const fg = over(tokens[fgToken], `#${bg.map(c => c.toString(16).padStart(2, '0')).join('')}`);
    const r = ratio(fg, bg);
    if (r < 4.5) failures.push(`${what}: ${fgToken} on ${bgToken} is ${r.toFixed(2)}:1`);
  }
  expect(failures, `${theme} theme contrast failures`).toEqual([]);
});
