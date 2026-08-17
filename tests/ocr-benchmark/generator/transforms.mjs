// Turns a "clean" rendered receipt PNG into something that looks like a real phone photo: rotated,
// placed on a table background at partial frame fill, lit unevenly, and re-compressed as JPEG. Sharp has
// no true perspective/homography primitive, so "perspective distortion" here is approximated with an
// affine shear -- a real limitation, documented in OCR_BENCHMARK.md rather than overclaimed.
import sharp from "sharp";

const tableBackgrounds = {
  light: [{ r: 235, g: 228, b: 214 }, { r: 244, g: 240, b: 233 }, { r: 220, g: 214, b: 200 }],
  dark: [{ r: 58, g: 46, b: 38 }, { r: 40, g: 40, b: 44 }, { r: 30, g: 26, b: 24 }],
};

async function noiseLayer(width, height, amount) {
  const buffer = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const value = Math.round(128 + (Math.random() - 0.5) * 255 * amount);
    buffer[index * 4] = value; buffer[index * 4 + 1] = value; buffer[index * 4 + 2] = value;
    buffer[index * 4 + 3] = Math.round(255 * Math.min(1, amount * 1.4));
  }
  return sharp(buffer, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const tierProfiles = {
  clean: { rotation: [0, 1], shear: 0, blur: [0, 0.15], noise: 0, frameFill: [0.82, 0.95], shadow: 0.05, exposure: [0.95, 1.05], jpegQuality: [92, 97] },
  normal: { rotation: [1, 5], shear: 0.02, blur: [0.15, 0.5], noise: 0.015, frameFill: [0.65, 0.85], shadow: 0.15, exposure: [0.85, 1.15], jpegQuality: [80, 92] },
  difficult: { rotation: [4, 11], shear: 0.05, blur: [0.4, 1.1], noise: 0.035, frameFill: [0.45, 0.7], shadow: 0.3, exposure: [0.7, 1.35], jpegQuality: [65, 82] },
  pathological: { rotation: [9, 19], shear: 0.09, blur: [0.7, 1.6], noise: 0.06, frameFill: [0.35, 0.55], shadow: 0.45, exposure: [0.55, 1.55], jpegQuality: [45, 68] },
};

function lerp(rng, [min, max]) { return min + rng.float() * (max - min); }

export async function photograph(cleanPng, rng, tier, options = {}) {
  const profile = tierProfiles[tier];
  const receiptMeta = await sharp(cleanPng).metadata();

  const rotation = lerp(rng, profile.rotation) * (rng.chance(0.5) ? 1 : -1);
  const shearAmount = profile.shear * (rng.chance(0.5) ? 1 : -1);
  let receipt = sharp(cleanPng);
  if (Math.abs(shearAmount) > 0.001) {
    receipt = receipt.affine([1, shearAmount, 0, 1], { background: { r: 255, g: 255, b: 255, alpha: 1 } });
  }
  const backgroundTone = options.backgroundTone || rng.pick(["light", "dark"]);
  const tableColor = rng.pick(tableBackgrounds[backgroundTone]);
  receipt = receipt.rotate(rotation, { background: { r: 255, g: 255, b: 255, alpha: 1 } });
  const rotatedBuffer = await receipt.toBuffer();
  const rotatedMeta = await sharp(rotatedBuffer).metadata();

  const frameFill = lerp(rng, profile.frameFill);
  const canvasWidth = Math.round(rotatedMeta.width / frameFill);
  const canvasHeight = Math.round(rotatedMeta.height / frameFill * (options.extraVerticalFrame || 1));
  const offsetX = Math.round((canvasWidth - rotatedMeta.width) * (0.3 + rng.float() * 0.4));
  const offsetY = Math.round((canvasHeight - rotatedMeta.height) * (0.3 + rng.float() * 0.4));

  const composites = [];
  if (profile.shadow > 0) {
    const shadowOffset = Math.round(8 + rng.float() * 14);
    const shadow = await sharp({ create: { width: rotatedMeta.width, height: rotatedMeta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: profile.shadow } } })
      .blur(12).png().toBuffer();
    composites.push({ input: shadow, left: Math.max(0, offsetX + shadowOffset), top: Math.max(0, offsetY + shadowOffset) });
  }
  composites.push({ input: rotatedBuffer, left: Math.max(0, offsetX), top: Math.max(0, offsetY) });
  if (profile.noise > 0) {
    const noise = await noiseLayer(canvasWidth, canvasHeight, profile.noise);
    composites.push({ input: noise, left: 0, top: 0, blend: "overlay" });
  }

  let composed = sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: tableColor } }).composite(composites);

  const exposure = lerp(rng, profile.exposure);
  const hueShift = backgroundTone === "light" && rng.chance(0.3) ? rng.int(-8, 8) : 0; // warm restaurant-lighting cast
  composed = composed.modulate({ brightness: exposure, saturation: 1 + (rng.float() - 0.5) * 0.1, hue: hueShift });

  const blurSigma = lerp(rng, profile.blur);
  if (blurSigma >= 0.3) composed = composed.blur(blurSigma);

  const quality = Math.round(lerp(rng, profile.jpegQuality));
  const finalBuffer = await composed.jpeg({ quality, chromaSubsampling: quality > 85 ? "4:4:4" : "4:2:0" }).toBuffer();
  return {
    buffer: finalBuffer,
    meta: { rotationDeg: Math.round(rotation * 10) / 10, shear: Math.round(shearAmount * 1000) / 1000, frameFill: Math.round(frameFill * 100) / 100, blurSigma: Math.round(blurSigma * 100) / 100, jpegQuality: quality, backgroundTone, canvasWidth, canvasHeight },
  };
}
