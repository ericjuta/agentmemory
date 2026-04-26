import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";
import { VERSION } from "../src/version.js";

describe("viewer document chrome", () => {
  it("renders the current version instead of a stale hardcoded badge", () => {
    const rendered = renderViewerDocument();
    expect(rendered.found).toBe(true);
    if (!rendered.found) return;

    expect(rendered.html).toContain(`v${VERSION}`);
    expect(rendered.html).not.toContain("__AGENTMEMORY_VIEWER_VERSION__");
    expect(rendered.html).not.toContain("v0.7.0");
  });

  it("renders the end-state top-level tab shell", () => {
    const rendered = renderViewerDocument();
    expect(rendered.found).toBe(true);
    if (!rendered.found) return;

    for (const label of [
      "Overview",
      "Sessions",
      "Memory",
      "Coordination",
      "Files",
      "Graph",
      "Diagnostics",
    ]) {
      expect(rendered.html).toContain(label);
    }

    expect(rendered.html).toContain('id="subtab-bar"');
    expect(rendered.html).toContain("operator-summary");
    expect(rendered.html).toContain("Work State");
    expect(rendered.html).toContain("Retrieval Quality");
    expect(rendered.html).toContain("System Snapshot");
    expect(rendered.html).not.toContain(">Dashboard<");
    expect(rendered.html).not.toContain(">Operations<");
  });
});
