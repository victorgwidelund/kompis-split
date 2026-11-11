import type { RainDrop } from "../utils/easterEggs";

// A short burst of falling pieces (money, or green-white hearts). Decorative only: aria-hidden,
// ignores pointer events, and hidden entirely for people who ask for reduced motion. The drops are
// randomised by makeRainDrops() in the event handler, so rendering itself stays pure.
export function Rain({ drops }: { drops: RainDrop[] }) {
  return <div className="rain" aria-hidden="true">
    {drops.map((drop, index) => <span key={index} style={{ left: `${drop.left}%`, fontSize: `${drop.size}px`, animationDelay: `${drop.delay}s`, animationDuration: `${drop.duration}s`, ["--spin" as string]: `${drop.spin}deg` }}>{drop.piece}</span>)}
  </div>;
}
