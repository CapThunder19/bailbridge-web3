import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, degrees } from "pdf-lib";

/** Standard PDF fonts use WinAnsi encoding; replace characters it cannot encode. */
export function sanitize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/₹/g, "Rs ")
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7E -ÿ–—•]/g, "?");
}

const NAVY = rgb(0.06, 0.13, 0.27);
const GREY = rgb(0.35, 0.35, 0.4);
const RED = rgb(0.7, 0.1, 0.1);

/** Simple top-down text flow with automatic line wrapping and page breaks. */
export class Flow {
  page!: PDFPage;
  y = 0;
  readonly margin = 56;
  readonly width = 595.28; // A4
  readonly height = 841.89;

  private constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    private readonly watermark: string | null,
  ) {}

  static async create(watermark: string | null): Promise<Flow> {
    const doc = await PDFDocument.create();
    const flow = new Flow(
      doc,
      await doc.embedFont(StandardFonts.Helvetica),
      await doc.embedFont(StandardFonts.HelveticaBold),
      watermark,
    );
    flow.newPage();
    return flow;
  }

  newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
    if (this.watermark) {
      this.page.drawText(sanitize(this.watermark), {
        x: 120,
        y: 260,
        size: 64,
        font: this.bold,
        color: rgb(0.85, 0.85, 0.88),
        rotate: degrees(40),
        opacity: 0.5,
      });
    }
  }

  private ensure(space: number) {
    if (this.y - space < this.margin + 30) this.newPage();
  }

  get contentWidth() {
    return this.width - this.margin * 2;
  }

  wrap(text: string, size: number, font: PDFFont, maxWidth = this.contentWidth): string[] {
    const lines: string[] = [];
    for (const paragraph of sanitize(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(
    text: string,
    opts: { size?: number; bold?: boolean; color?: "navy" | "grey" | "red"; indent?: number; gap?: number; maxWidth?: number } = {},
  ) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.font;
    const color = opts.color === "grey" ? GREY : opts.color === "red" ? RED : NAVY;
    const indent = opts.indent ?? 0;
    for (const line of this.wrap(text, size, font, (opts.maxWidth ?? this.contentWidth) - indent)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: this.margin + indent, y: this.y - size, size, font, color });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 4;
  }

  heading(text: string) {
    this.y -= 6;
    this.text(text, { size: 12, bold: true, gap: 6 });
  }

  rule() {
    this.ensure(10);
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.width - this.margin, y: this.y },
      thickness: 0.6,
      color: GREY,
    });
    this.y -= 10;
  }

  /** Two-column key/value rows. */
  rows(pairs: [string, string][], keyWidth = 170) {
    for (const [k, v] of pairs) {
      const lines = this.wrap(v, 10.5, this.font, this.contentWidth - keyWidth);
      this.ensure(lines.length * 14.5);
      this.page.drawText(sanitize(k), { x: this.margin, y: this.y - 10.5, size: 10.5, font: this.bold, color: NAVY });
      for (const line of lines) {
        this.page.drawText(line, { x: this.margin + keyWidth, y: this.y - 10.5, size: 10.5, font: this.font, color: NAVY });
        this.y -= 14.5;
      }
    }
    this.y -= 4;
  }

  /** Footer on every page. */
  footer(text: string) {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      p.drawText(sanitize(`${text}   |   Page ${i + 1} of ${pages.length}`), {
        x: this.margin,
        y: 28,
        size: 8,
        font: this.font,
        color: GREY,
      });
    });
  }
}
