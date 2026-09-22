import { describe, expect, it } from "vitest";
import {
  buildNoReasoningEffortLookup,
  buildRawModelLookup,
  processModels,
} from "../src/models/processing.js";
import type { CursorModel } from "../src/stream/model-discovery.js";

function m(id: string, name: string, reasoning = false, contextWindow = 200_000): CursorModel {
  return { id, name, reasoning, contextWindow, maxTokens: 64_000 };
}

describe("Curated model processing and alias routing", () => {
  it("collapses thinking and effort variants into a single clean base model", () => {
    const raw: CursorModel[] = [
      m("claude-4.6-sonnet", "Sonnet 4.6"),
      m("claude-4.6-sonnet-thinking", "Sonnet 4.6 Thinking"),
      m("claude-4.6-sonnet-medium", "Sonnet 4.6 Medium"),
      m("claude-4.6-sonnet-high", "Sonnet 4.6 High"),
    ];

    const processed = processModels(raw);
    expect(processed).toHaveLength(1);

    const sonnet = processed[0]!;
    expect(sonnet.id).toBe("claude-4.6-sonnet");
    expect(sonnet.name).toBe("Sonnet 4.6");
    expect(sonnet.supportsEffort).toBe(true);
    expect(sonnet.effortMap?.high).toBe("high");
    expect(sonnet.effortMap?.medium).toBe("medium");
    expect(sonnet.aliases).toContain("claude-4.6-sonnet-thinking");
    expect(sonnet.aliases).toContain("claude-4.6-sonnet-medium");
    expect(sonnet.aliases).toContain("claude-4.6-sonnet-high");
  });

  it("collapses fast variants into base model and preserves alias lookup", () => {
    const raw: CursorModel[] = [
      m("composer-2", "Composer 2"),
      m("composer-2-fast", "Composer 2 Fast"),
    ];

    const processed = processModels(raw);
    expect(processed).toHaveLength(1);

    const comp = processed[0]!;
    expect(comp.id).toBe("composer-2");
    expect(comp.name).toBe("Composer 2");
    expect(comp.aliases).toContain("composer-2-fast");

    const lookup = buildRawModelLookup(processed);
    expect(lookup.has("composer-2")).toBe(true);
    expect(lookup.has("composer-2-fast")).toBe(true);
  });

  it("routes old alias IDs correctly in buildRawModelLookup", () => {
    const raw: CursorModel[] = [
      m("gpt-5.4", "GPT-5.4"),
      m("gpt-5.4-high", "GPT-5.4 High"),
      m("gpt-5.4-fast", "GPT-5.4 Fast"),
    ];

    const processed = processModels(raw);
    const lookup = buildRawModelLookup(processed);

    expect(lookup.has("gpt-5.4")).toBe(true);
    expect(lookup.has("gpt-5.4-high")).toBe(true);
    expect(lookup.has("gpt-5.4-fast")).toBe(true);

    const noEffortLookup = buildNoReasoningEffortLookup(processed);
    expect(noEffortLookup).toBeDefined();
  });

  it("respects PI_CURSOR_RAW_MODELS escape hatch", () => {
    const raw: CursorModel[] = [
      m("claude-4.6-sonnet", "Sonnet 4.6"),
      m("claude-4.6-sonnet-thinking", "Sonnet 4.6 Thinking"),
    ];

    const oldEnv = process.env.PI_CURSOR_RAW_MODELS;
    try {
      process.env.PI_CURSOR_RAW_MODELS = "1";
      const processed = processModels(raw);
      expect(processed).toHaveLength(2);
      expect(processed.map((x) => x.id)).toEqual([
        "claude-4.6-sonnet",
        "claude-4.6-sonnet-thinking",
      ]);
    } finally {
      if (oldEnv === undefined) {
        delete process.env.PI_CURSOR_RAW_MODELS;
      } else {
        process.env.PI_CURSOR_RAW_MODELS = oldEnv;
      }
    }
  });
});
