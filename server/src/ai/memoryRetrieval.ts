// Per-message memory retrieval: the facts relevant to what the user just said, injected into the
// latest user message by runAssistantChat (never the cached system block — see the spec
// docs/superpowers/specs/2026-09-23-personal-memory-graph-design.md §3). Pure SQLite, no LLM call:
// remembered entities mentioned by name/alias pull their facts and relations; everything else comes
// from an OR/bm25 full-text search. Facts in the core profile (listCoreProfile — the newest
// CORE_PROFILE_LIMIT core facts) are skipped because they're already in the system prompt; an older core fact that has aged
// out of the profile is retrieved like any other.
import {
  listCoreProfile,
  listRememberedEntities,
  listActiveFactsForEntity,
  listEntityRelations,
  searchActiveFacts,
  type MemoryNoteRow,
} from "../db/store.js";

export const RELEVANT_MEMORY_HEADER =
  "Relevant things you remember (background from memory, not part of the user's message — use only if relevant):";

const MAX_MATCHED_ENTITIES = 3;
const FACTS_PER_ENTITY = 5;
const FTS_LIMIT = 8;
const MAX_FACTS = 12;
const MAX_CHARS = 1500;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word, case-insensitive: "Sam" must not match "Samsung". Lookarounds on letters/digits
// rather than \b, because \b is ASCII-only and names aren't.
export function mentionsName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

export function retrieveRelevantMemory(ownerId: number, text: string): string | null {
  if (!text.trim()) return null;

  const lines: string[] = [];
  const profileIds = listCoreProfile(ownerId).map((f) => f.id);
  const seenFacts = new Set<number>(profileIds);
  let chars = 0;
  let factCount = 0;

  const pushLine = (line: string): boolean => {
    if (chars + line.length + 1 > MAX_CHARS) return false;
    lines.push(line);
    chars += line.length + 1;
    return true;
  };
  const pushFact = (fact: MemoryNoteRow) => {
    if (seenFacts.has(fact.id) || factCount >= MAX_FACTS) return;
    if (pushLine(`- [#${fact.id}] ${fact.content}`)) {
      seenFacts.add(fact.id);
      factCount += 1;
    }
  };

  const matched = listRememberedEntities(ownerId)
    .map((entity) => {
      const hits = [entity.name, ...entity.aliases].filter((n) => mentionsName(text, n));
      return { entity, longest: Math.max(0, ...hits.map((h) => h.length)) };
    })
    .filter((m) => m.longest > 0)
    .sort((a, b) => b.longest - a.longest)
    .slice(0, MAX_MATCHED_ENTITIES);

  for (const { entity } of matched) {
    for (const fact of listActiveFactsForEntity(ownerId, entity.id, FACTS_PER_ENTITY)) pushFact(fact);
    for (const rel of listEntityRelations(ownerId, entity.id)) {
      pushLine(
        rel.direction === "out"
          ? `- ${entity.name} —${rel.relation}→ ${rel.entity.name}`
          : `- ${rel.entity.name} —${rel.relation}→ ${entity.name}`
      );
    }
  }

  for (const fact of searchActiveFacts(ownerId, text, { mode: "any", limit: FTS_LIMIT, excludeIds: profileIds })) {
    pushFact(fact);
  }

  return lines.length ? [RELEVANT_MEMORY_HEADER, ...lines].join("\n") : null;
}
