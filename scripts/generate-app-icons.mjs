// Renders the in-app logo (frontend/src/components/brandMarkSvg.ts) to the PNG app icons in public/.
// Run after changing the logo: node scripts/generate-app-icons.mjs
// Full-bleed green square with the artwork inside the central ~80% "safe zone", so the same files work
// as both "any" and "maskable" icons and as the iOS home-screen icon (which allows no transparency).
import sharp from "sharp";
import { brandMarkSvg } from "../frontend/src/components/brandMarkSvg.ts";

const artwork = brandMarkSvg("icon", false);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140"><rect width="140" height="140" fill="#00843d"/><g transform="translate(14 16) scale(0.8)">${artwork}</g></svg>`;
for (const [file, size] of [["public/icon-512.png", 512], ["public/icon-192.png", 192], ["public/apple-touch-icon.png", 180]]) {
  await sharp(Buffer.from(svg), { density: Math.ceil((size / 140) * 72 * 2) }).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
  console.log(`wrote ${file} (${size}x${size})`);
}
