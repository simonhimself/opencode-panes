import type { ArtifactType } from "@opencode-panes/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceCode, tokenizeSource } from "../../src/renderers/source-code";

describe("source highlighting", () => {
  it.each([
    ["html", '<section aria-label="sample">', ["tag", "attribute", "string"]],
    ["svg", '<circle cx="12" />', ["tag", "attribute", "string"]],
    ["react", "const count = 2; // note", ["keyword", "number", "comment"]],
    [
      "markdown",
      "# Heading\n**bold** `code`",
      ["heading", "emphasis", "keyword"],
    ],
    [
      "mermaid",
      "flowchart TD\nA --> B\n%% note",
      ["keyword", "operator", "comment"],
    ],
    [
      "code",
      'function run() { return "ok"; }',
      ["keyword", "string", "operator"],
    ],
  ] as const)(
    "recognizes a small %s token set",
    (type, source, expectedKinds) => {
      const kinds = tokenizeSource(source, type).flatMap((token) =>
        token.kind ? [token.kind] : [],
      );

      for (const kind of expectedKinds) expect(kinds).toContain(kind);
      expect(
        tokenizeSource(source, type)
          .map((token) => token.value)
          .join(""),
      ).toBe(source);
    },
  );

  it("renders hostile and unknown input only as escaped React text", () => {
    const source = '<script onload="alert(1)">ordinary words</script>';
    const markup = renderToStaticMarkup(
      <SourceCode source={source} type={"html" satisfies ArtifactType} />,
    );

    expect(markup).toContain("&lt;script");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("ordinary words");
    expect(markup).not.toContain("dangerouslySetInnerHTML");
  });

  it("gracefully leaves plain text unclassified", () => {
    expect(tokenizeSource("ordinary words", "code")).toEqual([
      { value: "ordinary words" },
    ]);
  });
});
