// Regression: the Swiss and Editorial templates linked Google Fonts, but every
// render path (srcDoc previews, the print iframe) inherits the app CSP
// (style-src 'self' 'unsafe-inline'; font-src 'self' data:), so the stylesheet
// was refused and both templates silently fell back to generic fonts. Bundled
// templates must be self-contained, with web fonts embedded as WOFF2 data URIs.
import { describe, expect, test } from "bun:test";
import { BUILTIN_TEMPLATES, readTemplateFile } from "../services/builtin-templates";

const WEB_FONTS: Record<string, string[]> = {
  swiss: ["DM Sans", "DM Mono"],
  editorial: ["Instrument Serif", "IBM Plex Sans"],
};

const REMOTE_RESOURCES = [
  /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i,
  /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i,
  /url\(\s*["']?(?:https?:)?\/\//i,
];

// The data URI itself contains a ";" (data:font/woff2;base64,...), so read it
// straight out of the rule body rather than splitting declarations on ";".
function fontFaces(html: string): { family: string; woff2: string | undefined }[] {
  return [...html.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
    family: /font-family:\s*["']([^"']+)["']/.exec(body)?.[1] ?? "",
    woff2: /src:\s*url\(\s*["']?data:font\/woff2;base64,([A-Za-z0-9+/=]+)/.exec(body)?.[1],
  }));
}

function templateHtml(slug: string): string {
  const tmpl = BUILTIN_TEMPLATES.find((t) => t.slug === slug);
  if (!tmpl) throw new Error(`No builtin template with slug ${slug}`);
  return readTemplateFile(tmpl.file);
}

describe("bundled invoice templates", () => {
  for (const tmpl of BUILTIN_TEMPLATES) {
    test(`${tmpl.slug} loads no remote stylesheets or fonts`, () => {
      const html = readTemplateFile(tmpl.file);
      for (const pattern of REMOTE_RESOURCES) expect(html).not.toMatch(pattern);
    });
  }

  for (const [slug, families] of Object.entries(WEB_FONTS)) {
    for (const family of families) {
      test(`${slug} embeds ${family} as WOFF2 data`, () => {
        const faces = fontFaces(templateHtml(slug)).filter((f) => f.family === family);
        expect(faces.length).toBeGreaterThan(0);
        for (const face of faces) {
          expect(face.woff2).toBeDefined();
          const magic = Buffer.from(face.woff2 ?? "", "base64")
            .subarray(0, 4)
            .toString("latin1");
          expect(magic).toBe("wOF2");
        }
      });
    }
  }
});
