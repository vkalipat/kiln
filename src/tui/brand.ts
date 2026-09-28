import { ansi } from "./theme";

const WORDMARK = [
  "██╗  ██╗██╗██╗     ███╗   ██╗",
  "██║ ██╔╝██║██║     ████╗  ██║",
  "█████╔╝ ██║██║     ██╔██╗ ██║",
  "██╔═██╗ ██║██║     ██║╚██╗██║",
  "██║  ██╗██║███████╗██║ ╚████║",
  "╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═══╝",
] as const;
const COLORS = [ansi.rgb(100, 57, 28), ansi.rgb(181, 102, 36), ansi.rgb(255, 159, 55), ansi.rgb(255, 210, 126), ansi.rgb(255, 244, 216)];
const paint = (text: string, level: number) => COLORS[Math.max(0, Math.min(4, level))]!(text);
const phase = (frame: number) => Number.isFinite(frame) ? Math.abs(Math.trunc(frame)) % 3600 : 0;

/** A moving light across fixed letterforms; geometry never shifts the composer. */
export function renderKilnWordmark(frame: number, compact = false): string[] {
  const sweep = (phase(frame) * 0.85) % (compact ? 15 : 41) - 2;
  return (compact ? ["K I L N"] : WORDMARK).map((line, row) => [...line].map((char, x) => {
    if (char === " ") return char;
    const distance = Math.abs(x - sweep + row * 0.7);
    return paint(char, distance < 2 ? 4 : distance < 5 ? 3 : 2);
  }).join(""));
}

type Point = readonly [number, number, number];
/** Small software rasterizer: three orbit planes and a rotating cubic furnace core. */
export function renderKilnCore(frame: number): string[] {
  const width = 50, height = 40;
  const pixels = new Uint8Array(width * height);
  const time = phase(frame) * 0.065;
  const cy = Math.cos(time), sy = Math.sin(time), cx = Math.cos(time * 0.53 + 0.4), sx = Math.sin(time * 0.53 + 0.4);
  const rotate = ([x, y, z]: Point): Point => {
    const xx = x * cy + z * sy, zz = z * cy - x * sy;
    return [xx, y * cx - zz * sx, y * sx + zz * cx];
  };
  const project = (point: Point): Point => {
    const [x, y, z] = rotate(point), perspective = 3.8 / (3.8 - z);
    return [width / 2 + x * 15 * perspective, height / 2 + y * 14 * perspective, z];
  };
  const dot = (x: number, y: number, level: number) => {
    const xx = Math.round(x), yy = Math.round(y);
    if (xx >= 0 && xx < width && yy >= 0 && yy < height) {
      const i = yy * width + xx; pixels[i] = Math.max(pixels[i]!, level);
    }
  };
  // Thin orbital paths remain subdued; moving hot particles trace their depth.
  for (let orbit = 0; orbit < 3; orbit++) {
    for (let i = 0; i < 180; i++) {
      const angle = i * Math.PI / 90;
      const a = Math.cos(angle) * 1.05, b = Math.sin(angle) * 1.05;
      const point: Point = orbit === 0 ? [a, b, 0] : orbit === 1 ? [a, 0, b] : [0, a, b];
      const [x, y, z] = project(point);
      const hot = (i - phase(frame) * 3 - orbit * 48 + 10800) % 180;
      dot(x, y, hot < 9 ? 5 : z > 0 ? 2 : 1);
    }
  }
  const vertices: Point[] = Array.from({ length: 8 }, (_, i) => [i & 1 ? 0.47 : -0.47, i & 2 ? 0.47 : -0.47, i & 4 ? 0.47 : -0.47]);
  for (let i = 0; i < 8; i++) for (const axis of [1, 2, 4]) {
    if (i & axis) continue;
    const a = project(vertices[i]!), b = project(vertices[i | axis]!);
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) * 2);
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      dot(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t > 0 ? 4 : 3);
    }
  }
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
  return Array.from({ length: height / 4 }, (_, row) => Array.from({ length: width / 2 }, (_, col) => {
    let mask = 0, level = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
      const value = pixels[(row * 4 + y) * width + col * 2 + x]!;
      if (value) { mask |= bits[y]![x]!; level = Math.max(level, value); }
    }
    return mask ? paint(String.fromCharCode(0x2800 + mask), level - 1) : " ";
  }).join(""));
}

/** Fixed-size art: large at desktop dimensions, legible at compact dimensions. */
export function renderKilnBrand(width: number, height: number, frame: number): string[] {
  if (width >= 60 && height >= 15) {
    const core = renderKilnCore(frame), word = renderKilnWordmark(frame);
    return core.map((line, row) => `${row >= 2 && row < 8 ? word[row - 2]! : " ".repeat(29)}    ${line}`);
  }
  if (width >= 32 && height >= 11) return renderKilnWordmark(frame);
  return renderKilnWordmark(frame, true);
}
