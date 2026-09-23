// Background extraction of durable facts from WhatsApp conversations into the memory graph
// (docs/superpowers/specs/2026-09-23-personal-memory-graph-design.md §2). Runs fire-and-forget
// from whatsappRoutes.ts on every inbound message; the common case is a no-op (one indexed
// SELECT). Every EXTRACTION_BATCH_SIZE fresh messages, one Haiku call turns them into validated
// operations — add a fact (optionally superseding one it was shown), link two remembered entities,
// or record an alias — applied in one transaction.
//
// Never throws. An API failure leaves the cursor where it was, so the batch is retried on the next
// inbound message; any successful response advances it, even if every operation was rejected, so a
// batch the model can't handle never wedges the pipeline.
import Anthropic from "@anthropic-ai/sdk";
import {
  resolveOwnerByPhone,
  recordApiUsage,
  getWhatsAppHistory,
  getWhatsAppMessagesAfter,
  getWhatsAppMessagesBefore,
  getMemoryExtractionCursor,
  setMemoryExtractionCursor,
  listCoreProfile,
  searchActiveFacts,
  listRememberedEntities,
  addFact,
  findOrCreateEntity,
  findEntityByName,
  addEntityAlias,
  linkEntitiesOnce,
  inTransaction,
  isMemoryKind,
  isReservedEntityType,
  type MemoryNoteRow,
  type RememberedEntitySummary,
  type WhatsAppMessageRow,
} from "../db/store.js";

export const EXTRACTION_BATCH_SIZE = 8;
const CONTEXT_MESSAGES = 2;
// A phone that has never been extracted starts at the raw history window (mirrors
// MAX_HISTORY_MESSAGES / conversationSummary.ts's RAW_HISTORY_WINDOW), not at its first-ever
// message: months-old messages processed after newer facts could otherwise "supersede" them with
// stale information. Older history is already covered by the rolling conversation summary.
const BOOTSTRAP_WINDOW = 24;
const CANDIDATE_FACT_LIMIT = 30;
const CANDIDATE_ENTITY_LIMIT = 50;
const MAX_FACT_LENGTH = 500;
const EXTRACTION_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// Messages arrive in quick bursts; without this two overlapping runs would read the same batch
// and write every fact twice.
const inFlight = new Set<string>();

const RECORD_MEMORY_TOOL: Anthropic.Tool = {
  name: "record_memory",
  description: "Record the memory operations for this batch. An empty operations list is a normal answer.",
  input_schema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add_fact", "link", "alias"] },
            content: { type: "string", description: "add_fact: one self-contained third-person sentence" },
            kind: { type: "string", enum: ["core", "fact", "preference"] },
            entity: {
              type: "object",
              properties: { name: { type: "string" }, type: { type: "string" } },
              description: "add_fact: the named person/place/organisation/project this fact is about, if any",
            },
            supersedes_id: { type: "number", description: "add_fact: id of a known fact this one replaces" },
            from: { type: "string", description: "link: entity name" },
            relation: { type: "string", description: "link: snake_case, e.g. works_at, sister_of" },
            to: { type: "string", description: "link: entity name" },
            alias: { type: "string", description: "alias: another name for `entity`" },
          },
          required: ["op"],
        },
      },
    },
    required: ["operations"],
  },
};

function transcript(rows: WhatsAppMessageRow[]): string {
  return rows.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
}

export function buildExtractionPrompt(input: {
  context: WhatsAppMessageRow[];
  batch: WhatsAppMessageRow[];
  candidates: MemoryNoteRow[];
  entities: RememberedEntitySummary[];
}): string {
  const known = input.candidates.length
    ? input.candidates.map((f) => `- [#${f.id}] (${f.kind}) ${f.content}`).join("\n")
    : "(none)";
  const entities = input.entities.length
    ? input.entities
        .map((e) => `- ${e.name} (${e.type}${e.aliases.length ? `; also: ${e.aliases.join(", ")}` : ""})`)
        .join("\n")
    : "(none)";
  return [
    "You maintain the long-term memory of a personal assistant about the person it works for.",
    `Facts already known (with ids):\n${known}`,
    `People, places, organisations and projects already known:\n${entities}`,
    input.context.length ? `Earlier messages, for context only (already processed):\n${transcript(input.context)}` : "",
    `New messages to process:\n${transcript(input.batch)}`,
    [
      "Call record_memory with the operations these NEW messages justify. Rules:",
      "- Only durable things worth knowing weeks from now: facts about the user and the people, places, organisations and projects in their life; routines; preferences; standing instructions. Not one-off task requests, small talk, or anything only true today.",
      "- Something the assistant said only counts if the user confirmed it.",
      "- Never record secrets: passwords, PINs, card or bank account numbers, one-time codes, security answers.",
      "- kind 'core' is only for identity-level facts: the user's name, partner/children/close family, home city, job/employer, a strong standing preference. Use 'preference' for likes/dislikes/how they want things done, otherwise 'fact'.",
      "- If a known fact already says it, record nothing. If the new messages change or correct a known fact, add the new fact with supersedes_id set to that fact's id.",
      "- Write each fact as one self-contained third-person sentence, e.g. \"Sarah Jones is the user's accountant at Acme.\"",
      "- When a fact is about a named person/place/organisation/project, set entity, reusing an existing name exactly rather than inventing a variant. Use link for a relationship between two named entities and alias when the user uses another name for a known one.",
      "- Zero operations is a normal, expected answer.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Validates each model-proposed operation independently — one malformed op is skipped without
// discarding its valid siblings. supersedes_id is only honoured for facts the model was actually
// shown (candidateIds), so it can never retire a fact by guessing an id; link/alias ops only ever
// act on entities that already exist (including ones an add_fact in this same batch just created).
export function applyMemoryOperations(
  ownerId: number,
  operations: unknown,
  candidateIds: Set<number>
): { applied: number; skipped: number } {
  const ops = Array.isArray(operations) ? operations : [];
  let applied = 0;
  let skipped = 0;
  const valid = (op: unknown): op is Record<string, unknown> => typeof op === "object" && op !== null;

  inTransaction(() => {
    // add_fact first so links/aliases in the same batch can refer to entities it creates.
    const ordered = [
      ...ops.filter((op) => valid(op) && op.op === "add_fact"),
      ...ops.filter((op) => !(valid(op) && op.op === "add_fact")),
    ];
    for (const op of ordered) {
      if (!valid(op)) {
        skipped += 1;
        continue;
      }
      if (op.op === "add_fact") {
        const content = nonEmptyString(op.content);
        if (!content || content.length > MAX_FACT_LENGTH || !isMemoryKind(op.kind)) {
          skipped += 1;
          continue;
        }
        const entityInput = valid(op.entity) ? op.entity : null;
        const entityName = nonEmptyString(entityInput?.name);
        const entityType = nonEmptyString(entityInput?.type);
        // A reserved type (booking, expense, travel_checkin, trip, important_email) is never
        // turned into an entity — the fact still counts as applied, just with no entity attached,
        // rather than injecting a bare {name, aliases} row into a table another pipeline reads by
        // type (list_bookings, the spending digest, trip prep).
        const entity =
          entityName && entityType && !isReservedEntityType(entityType)
            ? findOrCreateEntity(ownerId, entityType, entityName)
            : null;
        const supersedes = typeof op.supersedes_id === "number" && candidateIds.has(op.supersedes_id) ? op.supersedes_id : null;
        addFact(ownerId, { content, kind: op.kind, source: "extracted", entityId: entity?.id ?? null, supersedesId: supersedes });
        applied += 1;
      } else if (op.op === "link") {
        const from = nonEmptyString(op.from);
        const to = nonEmptyString(op.to);
        const relation = nonEmptyString(op.relation);
        const fromEntity = from ? findEntityByName(ownerId, from) : null;
        const toEntity = to ? findEntityByName(ownerId, to) : null;
        if (!fromEntity || !toEntity || !relation) {
          skipped += 1;
          continue;
        }
        linkEntitiesOnce(ownerId, fromEntity.id, relation, toEntity.id);
        applied += 1;
      } else if (op.op === "alias") {
        const name = nonEmptyString(op.entity);
        const alias = nonEmptyString(op.alias);
        const entity = name ? findEntityByName(ownerId, name) : null;
        if (!entity || !alias) {
          skipped += 1;
          continue;
        }
        addEntityAlias(ownerId, entity.id, alias);
        applied += 1;
      } else {
        skipped += 1;
      }
    }
  });
  return { applied, skipped };
}

function startingCursor(phone: string): number {
  const recent = getWhatsAppHistory(phone, BOOTSTRAP_WINDOW);
  return recent.length ? recent[0].id - 1 : 0;
}

export async function maybeExtractMemory(phone: string): Promise<void> {
  if (inFlight.has(phone)) return;
  inFlight.add(phone);
  try {
    const ownerId = resolveOwnerByPhone(phone);
    if (ownerId === null) return;

    const afterId = getMemoryExtractionCursor(phone) ?? startingCursor(phone);
    const batch = getWhatsAppMessagesAfter(phone, afterId, EXTRACTION_BATCH_SIZE);
    if (batch.length < EXTRACTION_BATCH_SIZE) return;

    const context = getWhatsAppMessagesBefore(phone, batch[0].id, CONTEXT_MESSAGES);
    const core = listCoreProfile(ownerId);
    const related = searchActiveFacts(ownerId, batch.map((m) => m.content).join("\n"), {
      mode: "any",
      limit: CANDIDATE_FACT_LIMIT,
    });
    const candidates = [...core, ...related.filter((f) => !core.some((c) => c.id === f.id))];
    const entities = listRememberedEntities(ownerId).slice(0, CANDIDATE_ENTITY_LIMIT);

    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 1024,
        tools: [RECORD_MEMORY_TOOL],
        tool_choice: { type: "tool", name: RECORD_MEMORY_TOOL.name },
        messages: [{ role: "user", content: buildExtractionPrompt({ context, batch, candidates, entities }) }],
      });
    } catch (err) {
      console.error("memoryExtraction: model call failed; batch will be retried", err);
      return;
    }

    recordApiUsage(
      ownerId,
      "whatsapp",
      EXTRACTION_MODEL,
      "memory_extraction",
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      response.usage?.cache_read_input_tokens ?? 0,
      response.usage?.cache_creation_input_tokens ?? 0
    );

    try {
      const toolUse = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === RECORD_MEMORY_TOOL.name
      );
      const operations = (toolUse?.input as { operations?: unknown } | undefined)?.operations;
      applyMemoryOperations(ownerId, operations, new Set(candidates.map((f) => f.id)));
    } catch (err) {
      console.error("memoryExtraction: applying operations failed; skipping batch", err);
    }
    setMemoryExtractionCursor(phone, batch[batch.length - 1].id);
  } catch (err) {
    console.error("memoryExtraction: unexpected failure", err);
  } finally {
    inFlight.delete(phone);
  }
}
