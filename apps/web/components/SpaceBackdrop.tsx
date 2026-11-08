'use client';

/**
 * Deep-space scene for the sign-in screen: nebula glow, twinkling stars, a
 * planet with rings and the Crew orbiting it, and the odd shooting star.
 * CSS + one inline SVG only (light on cheap phones); motion stops with
 * "reduce motion" and when the page is hidden (see space.css).
 */

// Deterministic star field (same on server and client, so no hydration mismatch).
function stars(count: number, seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: count }, (_, i) => ({ x: rnd() * 100, y: rnd() * 100, r: rnd() < 0.85 ? 0.6 + rnd() * 0.6 : 1.3 + rnd() * 0.9, o: 0.35 + rnd() * 0.65, tw: i % 5 === 0, d: rnd() * 6 }));
}
const FIELD = stars(140, 7);

const MOONS = [
  { agent: 'aria', lap: 26, r: 46, delay: 0 },
  { agent: 'vox', lap: 34, r: 58, delay: -9 },
  { agent: 'nudge', lap: 34, r: 58, delay: -26 },
  { agent: 'ledger', lap: 26, r: 46, delay: -13 },
  { agent: 'spark', lap: 44, r: 70, delay: -20 },
];

export function SpaceBackdrop() {
  return (
    <div className="space" aria-hidden>
      <div className="nebula n1" />
      <div className="nebula n2" />
      <div className="nebula n3" />
      <svg className="stars" viewBox="0 0 100 100" preserveAspectRatio="none">
        {FIELD.map((st, i) => (
          <circle key={i} cx={st.x} cy={st.y} r={st.r * 0.12} fill="#fff" opacity={st.o} className={st.tw ? 'tw' : undefined} style={st.tw ? { animationDelay: `${st.d}s` } : undefined} />
        ))}
      </svg>
      <div className="shooting" />
      <div className="planet-system">
        <div className="orbit-ring o1" />
        <div className="orbit-ring o2" />
        <div className="orbit-ring o3" />
        <div className="planet">
          <div className="planet-ring" />
        </div>
        {MOONS.map((m) => (
          <div key={m.agent} className="moon-lane" style={{ ['--lap' as any]: `${m.lap}s`, ['--delay' as any]: `${m.delay}s`, ['--r' as any]: `${m.r}%` }}>
            <span className={`moon a-${m.agent}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
