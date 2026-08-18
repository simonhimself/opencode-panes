import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownArtifactRenderer } from "../../src/renderers/markdown";

describe("Markdown rendering", () => {
  it("removes raw HTML instead of executing or rendering it", () => {
    const markup = renderToStaticMarkup(
      <MarkdownArtifactRenderer
        source={
          'Before <img src="x" onerror="alert(1)"> <script>alert(2)</script> After'
        }
      />,
    );

    expect(markup).toContain("Before");
    expect(markup).toContain("After");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("alert(1)");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("&lt;script");
  });

  it("does not create navigable links or remote images", () => {
    const markup = renderToStaticMarkup(
      <MarkdownArtifactRenderer source="[leave](https://attacker.example) ![track](https://attacker.example/pixel.png)" />,
    );

    expect(markup).not.toMatch(/<a(?:\s|>)/);
    expect(markup).not.toMatch(/<img(?:\s|>)/);
    expect(markup).not.toContain("attacker.example");
    expect(markup).toContain("leave");
    expect(markup).toContain("track");
  });
});
