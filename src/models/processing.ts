/**
 * Model parsing, effort mapping, and routing lookups.
 */

import type { CursorModel } from "../stream/model-discovery.js";
import type { CursorNativeModelRouting } from "../stream/model-routing.js";
import { estimateModelCost } from "./cost.js";
import { clampCursorContextWindow } from "./limits.js";
import { ProviderConstant, type PiThinkingLevel } from "../types/enums.js";

export type CursorModelRouting = CursorNativeModelRouting;

export const CURSOR_EFFORT_SUFFIXES: Array<{ suffix: string; effort: string }> = [
  { suffix: "extra-high", effort: "xhigh" },
  { suffix: "minimal", effort: "minimal" },
  { suffix: "xhigh", effort: "xhigh" },
  { suffix: "medium", effort: "medium" },
  { suffix: "high", effort: "high" },
  { suffix: "low", effort: "low" },
  { suffix: "max", effort: "max" },
  { suffix: "none", effort: "none" },
];

export type CursorEffortMap = Record<PiThinkingLevel, string | null>;

export interface ParsedModelId {
  base: string; // model ID with effort stripped
  effort: string; // effort level, or "" if no effort suffix
  fast: boolean; // has -fast suffix
  thinking: boolean; // has -thinking suffix
}

export function stripEffortSuffix(id: string): { remaining: string; effort: string } {
  for (const { suffix, effort } of CURSOR_EFFORT_SUFFIXES) {
    const marker = `-${suffix}`;
    if (id.endsWith(marker)) {
      return { remaining: id.slice(0, -marker.length), effort };
    }
  }
  return { remaining: id, effort: "" };
}

export function parseModelId(id: string): ParsedModelId {
  let remaining = id;
  let fast = false;
  let thinking = false;

  if (remaining.endsWith("-fast")) {
    fast = true;
    remaining = remaining.slice(0, -5);
  }

  // Cursor has used both orders for thinking effort variants:
  //   claude-4.6-opus-max-thinking       (effort before -thinking)
  //   claude-opus-4-7-thinking-max       (effort after -thinking)
  let effort: string;
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -9);
    const parsed = stripEffortSuffix(remaining);
    remaining = parsed.remaining;
    effort = parsed.effort;
  } else {
    const parsed = stripEffortSuffix(remaining);
    remaining = parsed.remaining;
    effort = parsed.effort;
    if (remaining.endsWith("-thinking")) {
      thinking = true;
      remaining = remaining.slice(0, -9);
    }
  }

  return { base: remaining, effort, fast, thinking };
}

export interface ProcessedModel extends CursorModel {
  supportsEffort: boolean;
  effortMap?: CursorEffortMap;
  rawModelByEffort?: Record<string, string>;
  rawRoutingByEffort?: Record<string, CursorModelRouting>;
  aliases?: string[];
}

export function buildNoReasoningEffortLookup(models: ProcessedModel[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const model of models) {
    if (
      model.supportsEffort &&
      model.effortMap &&
      Object.values(model.effortMap).includes("none")
    ) {
      lookup.set(model.id, "none");
      if (model.aliases) {
        for (const alias of model.aliases) lookup.set(alias, "none");
      }
    }
  }
  return lookup;
}

function routingForModel(model: CursorModel): CursorModelRouting | undefined {
  if (
    !model.requestedModelId &&
    !model.parameters?.length &&
    !model.requiresMaxMode &&
    typeof model.requestedMaxMode !== "boolean"
  ) {
    return undefined;
  }
  return {
    modelId: model.requestedModelId ?? model.id,
    ...(model.parameters?.length ? { parameters: model.parameters } : {}),
    ...(model.requiresMaxMode ? { requiresMaxMode: true } : {}),
    ...(typeof model.requestedMaxMode === "boolean"
      ? { requestedMaxMode: model.requestedMaxMode }
      : {}),
  };
}

function defaultRoutingEffort(model: ProcessedModel): string | undefined {
  const routes = model.rawRoutingByEffort;
  if (!routes) return undefined;
  const mappedMedium = model.effortMap?.medium;
  for (const effort of [mappedMedium, "medium", "", "low", "high", "none", "xhigh", "max"]) {
    if (typeof effort === "string" && routes[effort]) return effort;
  }
  return Object.keys(routes)[0];
}

export function buildRawModelLookup(
  models: ProcessedModel[],
): Map<string, Record<string, CursorModelRouting>> {
  const lookup = new Map<string, Record<string, CursorModelRouting>>();
  for (const model of models) {
    if (model.supportsEffort && model.rawRoutingByEffort) {
      const routes = { ...model.rawRoutingByEffort };
      if (model.effortMap) {
        for (const [piEffort, cursorEffort] of Object.entries(model.effortMap)) {
          if (typeof cursorEffort === "string" && !routes[piEffort] && routes[cursorEffort]) {
            routes[piEffort] = routes[cursorEffort];
          }
        }
      }
      const defaultEffort = defaultRoutingEffort(model);
      if (defaultEffort !== undefined && !routes[""])
        routes[""] = model.rawRoutingByEffort[defaultEffort]!;
      lookup.set(model.id, routes);
      if (model.aliases) {
        for (const alias of model.aliases) {
          if (!lookup.has(alias)) lookup.set(alias, routes);
        }
      }
      continue;
    }

    const routing = routingForModel(model);
    if (routing) {
      lookup.set(model.id, { "": routing });
      if (model.aliases) {
        for (const alias of model.aliases) {
          if (!lookup.has(alias)) lookup.set(alias, { "": routing });
        }
      }
    }
  }
  return lookup;
}

export function applyRawCursorModelId(
  payload: Record<string, unknown>,
  rawRoutingByEffortByModelId: Map<string, Record<string, CursorModelRouting>>,
): void {
  if (typeof payload.model !== "string") return;
  const rawRoutingByEffort = rawRoutingByEffortByModelId.get(payload.model);
  const effort = typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : "";
  const routing = rawRoutingByEffort?.[effort];
  if (!routing) return;
  payload.cursor_model_id = routing.modelId;
  if (routing.parameters?.length) payload.cursor_model_parameters = routing.parameters;
  if (routing.requiresMaxMode) payload.cursor_requires_max_mode = true;
  if (typeof routing.requestedMaxMode === "boolean")
    payload.cursor_model_max_mode = routing.requestedMaxMode;
}

export function applyNoReasoningEffort(
  payload: Record<string, unknown>,
  thinkingLevel: string,
  noReasoningEffortByModelId: Map<string, string>,
): void {
  if (thinkingLevel !== "off") {
    return;
  }
  if (payload.reasoning_effort !== undefined || typeof payload.model !== "string") {
    return;
  }
  const noReasoningEffort = noReasoningEffortByModelId.get(payload.model);
  if (noReasoningEffort) payload.reasoning_effort = noReasoningEffort;
}

export function supportsReasoningModelId(id: string): boolean {
  const { base, effort, thinking } = parseModelId(id);
  if (effort || thinking) return true;
  if (base === "default" || base === "auto") return true;
  return /^(claude|composer|gemini|gpt|grok|kimi)(-|$)/i.test(base);
}

/**
 * Map only controls Cursor explicitly advertised. Null hides unsupported Pi
 * levels instead of silently routing them to a different Cursor effort.
 */
export function buildEffortMap(efforts: Set<string>): CursorEffortMap {
  const supported = (effort: string): string | null => (efforts.has(effort) ? effort : null);
  return {
    off: supported("none"),
    minimal: supported("minimal"),
    low: supported("low"),
    // A bare Cursor model ID is the provider's default effort, equivalent to Pi medium.
    medium: efforts.has("medium") ? "medium" : supported(""),
    high: supported("high"),
    xhigh: supported("xhigh"),
    max: supported("max"),
  };
}

export function cleanDisplayName(name: string): string {
  const cleaned = name
    .replace(/\b(Extra High|High|Medium|Low|Max|None|Thinking|Fast)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || name;
}

/** Dedup raw models: collapse effort variants into one entry with supportsReasoningEffort. */
export function processModels(raw: CursorModel[]): ProcessedModel[] {
  if (process.env.PI_CURSOR_RAW_MODELS) {
    return raw
      .map((model) => ({
        ...model,
        contextWindow: clampCursorContextWindow(model.id, model.name, model.contextWindow),
        supportsEffort: false,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // Group by base model ID (collapsing effort, thinking, and fast variants)
  const groups = new Map<
    string,
    {
      base: string;
      variants: Array<{ model: CursorModel; parsed: ParsedModelId }>;
    }
  >();

  for (const model of raw) {
    const p = parseModelId(model.id);
    let g = groups.get(p.base);
    if (!g) {
      g = {
        base: p.base,
        variants: [],
      };
      groups.set(p.base, g);
    }
    g.variants.push({ model, parsed: p });
  }

  const result: ProcessedModel[] = [];

  for (const g of groups.values()) {
    // Pick the best representative variant (prefer clean/medium/standard)
    const sorted = [...g.variants].sort((a, b) => {
      const score = (v: typeof a) => {
        let s = 0;
        if (!v.parsed.fast) s += 10;
        if (!v.parsed.thinking) s += 5;
        if (v.parsed.effort === "" || v.parsed.effort === "medium") s += 3;
        return s;
      };
      return score(b) - score(a);
    });
    const repVariant = sorted[0]!;
    const rep = repVariant.model;
    const id = g.base;
    const name = cleanDisplayName(rep.name);

    // Collect effort levels and reasoning support
    const effortNames = new Set<string>();
    let hasThinking = false;
    for (const v of g.variants) {
      if (v.parsed.effort) effortNames.add(v.parsed.effort);
      if (v.parsed.thinking || v.model.reasoning) hasThinking = true;
    }

    const isKnownReasoning = supportsReasoningModelId(id);
    const supportsEffort = effortNames.size > 0 || hasThinking || isKnownReasoning;

    let effortMap: CursorEffortMap | undefined;
    if (supportsEffort) {
      effortMap = buildEffortMap(effortNames);
      // For models that support thinking but only offer a binary -thinking variant:
      if (hasThinking && effortNames.size === 0) {
        effortMap.off = "none";
        effortMap.low = "low";
        effortMap.medium = "medium";
        effortMap.high = "high";
      }
    }

    const rawModelByEffort: Record<string, string> = {};
    const rawRoutingByEffort: Record<string, CursorModelRouting> = {};

    for (const v of g.variants) {
      const routing = routingForModel(v.model) ?? { modelId: v.model.id };
      if (v.parsed.effort) {
        rawModelByEffort[v.parsed.effort] = v.model.id;
        rawRoutingByEffort[v.parsed.effort] = routing;
      }
      if (v.parsed.thinking) {
        for (const lvl of ["high", "medium", "max", "xhigh"]) {
          if (!rawRoutingByEffort[lvl]) {
            rawModelByEffort[lvl] = v.model.id;
            rawRoutingByEffort[lvl] = routing;
          }
        }
      } else if (!v.parsed.fast) {
        for (const lvl of ["", "none", "off", "low"]) {
          if (!rawRoutingByEffort[lvl]) {
            rawModelByEffort[lvl] = v.model.id;
            rawRoutingByEffort[lvl] = routing;
          }
        }
      }
    }

    if (!rawRoutingByEffort[""]) {
      rawRoutingByEffort[""] = routingForModel(rep) ?? { modelId: rep.id };
      rawModelByEffort[""] = rep.id;
    }

    // Collect aliases for seamless backward compatibility
    const aliases = new Set<string>();
    for (const v of g.variants) {
      if (v.model.id !== id) aliases.add(v.model.id);
    }
    // Automatically support standard variant aliases (e.g. <base>-thinking, <base>-fast)
    if (supportsEffort) {
      aliases.add(`${id}-thinking`);
    }
    aliases.add(`${id}-fast`);
    if (supportsEffort) {
      aliases.add(`${id}-fast-thinking`);
      aliases.add(`${id}-thinking-fast`);
    }

    result.push({
      ...rep,
      id,
      name,
      contextWindow: clampCursorContextWindow(id, name, rep.contextWindow),
      supportsEffort,
      effortMap,
      rawModelByEffort,
      rawRoutingByEffort,
      aliases: aliases.size > 0 ? [...aliases] : undefined,
    });
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function modelConfig(m: ProcessedModel) {
  const input = (m.supportsImages === false ? ["text"] : ["text", "image"]) as ("text" | "image")[];
  return {
    id: m.id,
    name: m.name,
    // Keep api explicit on every model so session restore / models.json merges
    // cannot strand rows on a different transport id.
    api: ProviderConstant.NativeApi,
    // Pi's thinking control must only appear when Cursor exposed selectable
    // effort variants. A model name alone is not evidence of a controllable level.
    reasoning: m.supportsEffort,
    ...(m.supportsEffort &&
      m.effortMap && {
        thinkingLevelMap: m.effortMap,
      }),
    input,
    cost: estimateModelCost(m.id),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}
