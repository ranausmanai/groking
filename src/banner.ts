import process from "node:process";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// Each letter's color: G R O K I N G
const LETTER_COLORS: Array<[number, number, number]> = [
  [255, 70, 70],   // G - red
  [255, 150, 50],  // R - orange
  [255, 220, 50],  // O - yellow
  [50, 220, 120],  // K - green
  [50, 180, 255],  // I - cyan
  [100, 100, 255], // N - blue
  [200, 100, 255]  // G - purple
];

// Each sub-array is one letter rendered line-by-line (5 rows)
const LETTERS: string[][] = [
  // G
  [" ██████ ",
   "██      ",
   "██  ███ ",
   "██   ██ ",
   " ██████ "],
  // R
  ["██████  ",
   "██   ██ ",
   "██████  ",
   "██  ██  ",
   "██   ██ "],
  // O
  [" █████  ",
   "██   ██ ",
   "██   ██ ",
   "██   ██ ",
   " █████  "],
  // K
  ["██  ██ ",
   "██ ██  ",
   "████   ",
   "██ ██  ",
   "██  ██ "],
  // I
  ["██ ",
   "██ ",
   "██ ",
   "██ ",
   "██ "],
  // N
  ["██   ██ ",
   "███  ██ ",
   "██ █ ██ ",
   "██  ███ ",
   "██   ██ "],
  // G
  [" ██████ ",
   "██      ",
   "██  ███ ",
   "██   ██ ",
   " ██████ "]
];

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

function rgb(text: string, r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m${text}`;
}

function buildBannerLines(): string[] {
  const rows = LETTERS[0].length; // 5 rows
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "  ";
    for (let li = 0; li < LETTERS.length; li++) {
      line += LETTERS[li][row];
    }
    lines.push(line);
  }
  return lines;
}

function colorizeLine(line: string): string {
  let out = "";
  let col = 0;
  for (const char of line) {
    if (char === " ") {
      out += char;
      col++;
      continue;
    }
    // Map column to letter index
    const letterIdx = getLetterIndex(col);
    const [r, g, b] = LETTER_COLORS[letterIdx];
    out += rgb(char, r, g, b);
    col++;
  }
  return out + RESET;
}

function getLetterIndex(col: number): number {
  // 2 chars padding, then each letter occupies its width
  let pos = 2;
  for (let i = 0; i < LETTERS.length; i++) {
    const width = LETTERS[i][0].length;
    if (col < pos + width) return i;
    pos += width;
  }
  return LETTERS.length - 1;
}

export function printGrokingBanner(): void {
  const lines = buildBannerLines();

  if (!supportsColor()) {
    console.log(`\n${lines.join("\n")}\n`);
    console.log("GROKING  |  Terminal coding agent for Grok\n");
    return;
  }

  const colored = lines.map((line) => colorizeLine(line));
  const subtitle = rgb(`${BOLD}  Terminal coding agent for Grok`, 0, 200, 255);
  const tip = rgb("  Tip: /help for commands, /reset to clear context", 120, 110, 160);

  console.log();
  console.log(colored.join("\n"));
  console.log();
  console.log(`${subtitle}`);
  console.log(`${tip}\n`);
}
