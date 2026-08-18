import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../../src/renderers/svg";

describe("SVG sanitization", () => {
  it("removes scripts, event handlers, external resources, and unsafe CSS URLs", () => {
    const sanitized = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <image href="https://attacker.example/pixel.png" />
        <a xlink:href="javascript:alert(1)"><text>bad</text></a>
        <style>@import url("https://attacker.example/theme.css");</style>
        <rect fill="url(https://attacker.example/fill.svg#paint)" style="background:url(https://attacker.example/x)" />
        <defs><linearGradient id="safe" /></defs>
        <rect fill="url(#safe)" />
      </svg>
    `);

    expect(sanitized).not.toMatch(
      /script|onload|attacker\.example|javascript:|<style|style=/i,
    );
    expect(sanitized).toContain('fill="url(#safe)"');
  });
});
