// "Pengaregn": two clinking green-white (Hammarby) glasses with coins and notes raining around them.
// The same markup renders the in-app mark and the PNG app icons (scripts/generate-app-icons.mjs).
const ink = "#17201c";
const green = "#00843d";

function glass(clipId: string, x: number, rotation: number, pivotX: number) {
  const left = x, right = x + 34;
  const outline = `M${left} 52 L${right} 52 L${right - 4} 108 L${left + 4} 108 Z`;
  const foam = rotation < 0 ? [[left + 7, 50, 8], [left + 19, 46, 9], [left + 29, 51, 7]] : [[left + 7, 51, 7], [left + 17, 46, 9], [left + 28, 50, 8]];
  return `<g transform="rotate(${rotation} ${pivotX} 78)">
    <clipPath id="${clipId}"><path d="${outline}"/></clipPath>
    <g clip-path="url(#${clipId})"><rect x="${left - 3}" y="50" width="40" height="60" fill="#fff"/><rect x="${left + 5}" y="50" width="8" height="60" fill="${green}"/><rect x="${left + 21}" y="50" width="8" height="60" fill="${green}"/></g>
    <path d="${outline}" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linejoin="round"/>
    ${foam.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${ink}" stroke-width="3"/>`).join("")}
    <path d="M${left + 1} 54 L${right - 1} 54" stroke="#fff" stroke-width="6"/>
  </g>`;
}

const coin = (x: number, y: number, rotation: number, scale: number) =>
  `<g transform="translate(${x} ${y}) rotate(${rotation}) scale(${scale})"><circle r="6" fill="#f6ca67" stroke="${ink}" stroke-width="2.5"/><path d="M-2 -2 L2 2" stroke="${ink}" stroke-width="1.5"/></g>`;
const note = (x: number, y: number, rotation: number, scale: number) =>
  `<g transform="translate(${x} ${y}) rotate(${rotation}) scale(${scale})"><rect x="-9" y="-5" width="18" height="10" rx="2" fill="#c7e6d2" stroke="${ink}" stroke-width="2.5"/><circle r="2.5" fill="none" stroke="${ink}" stroke-width="1.5"/></g>`;

/** Inner SVG markup in a 140x140 box; idPrefix keeps clip-path ids unique per instance. */
export function brandMarkSvg(idPrefix: string, withBackground = true) {
  return [
    withBackground ? `<path d="M70 12 C108 10 130 32 128 70 C126 108 104 130 66 128 C30 126 10 104 12 68 C14 32 34 14 70 12 Z" fill="${green}"/>` : "",
    note(30, 34, -25, 1), coin(112, 30, -15, 0.85), coin(22, 74, 0, 0.75), note(116, 76, 28, 1), coin(42, 16, 0, 0.6), note(98, 15, 12, 0.7),
    glass(`${idPrefix}-left`, 33, -16, 50),
    glass(`${idPrefix}-right`, 73, 16, 90),
    `<circle cx="70" cy="27" r="12" fill="#f6ca67" stroke="${ink}" stroke-width="3.5"/><path d="M64 23 C66 20 70 19 73 20" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`,
    `<path d="M50 22 L55 26 M90 22 L85 26" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>`,
  ].join("");
}
