# cognitive-memory

**Three-tier AI agent memory system with sleep-like consolidation, episodic recording, and relationship tracking.**

> Extracted from [Agent Friday](https://github.com/FutureSpeakAI/Agent-Friday) — the AGI OS by [FutureSpeak.AI](https://futurespeak.ai)

---

## Why Cognitive Memory?

Most AI agents have flat memory — a list of facts or a vector store. Human cognition is richer: short-term working memory, medium-term observations that need reinforcement, long-term confirmed facts, episodic recall of past conversations, and an evolving sense of relationship with the people we interact with.

`cognitive-memory` implements this full cognitive stack for AI agents:

1. **Three-Tier Memory** — Short-term conversation buffer, medium-term patterns (with session-aware reinforcement tracking), and long-term confirmed facts
2. **Sleep-Like Consolidation** — Periodic process that promotes strong medium-term observations to long-term, merges duplicates, and extracts cross-episode insights
3. **Episodic Memory** — Timestamped session recordings with AI-generated summaries, topics, emotional tone, and key decisions
4. **Relationship Tracking** — Evolving model of the AI-user relationship: streaks, inside jokes, shared references, communication preferences, and logarithmic trust growth

## Key Concepts

### Jaccard Deduplication

Memory systems are useless if they store "User likes dark mode" and "User prefers dark mode in all apps" as separate facts. The engine uses Jaccard similarity with stop-word filtering — computing word-set overlap and requiring >= 80% similarity to flag duplicates. This avoids the classic substring bug where "he" matches "she likes cheese".

### Weighted Promotion Scoring

Medium-term observations don't get promoted to long-term on a simple threshold. A weighted scoring formula considers:

| Signal | Weight | Description |
|--------|--------|-------------|
| Frequency | min(occurrences, 10) x 2 | How often observed (max 20) |
| Cross-Session | min(sessions, 5) x 2 | Observed across distinct sessions (max 10) |
| Time-Span | +5 if >= 7 days, +3 if >= 3 days | Persistence over time |
| Confidence | +3 if >= 0.9 | Extraction confidence |
| Staleness | -5 if >14 days stale, -2 if >7 days | Penalty for unreinforced observations |

Promotion requires **score >= 10 AND occurrences >= 3**. This prevents one-off session bursts while surfacing observations that persist across time.

### Episodic Search Weighting

Episode search uses weighted scoring across multiple fields:

| Field | Weight |
|-------|--------|
| Summary match | 10 |
| Topic match | 5 per topic |
| Key decision match | 4 per decision |
| Transcript match | 1 per episode |
| Recency bonus | +3 if < 24h, +1 if < 1 week |

### Relationship Trust Formula

Trust grows logarithmically with interaction count and gets a streak bonus:

```
trust = 0.3 + log10(sessions + 1) * 0.2 + min(streak * 0.02, 0.2)
```

This means trust builds quickly at first (sessions 1-10 matter most) but saturates — exactly like real relationships.

## Installation

```bash
npm install cognitive-memory
```

## Quick Start

### Three-Tier Memory

```typescript
import { MemoryManager } from 'cognitive-memory';

const memory = new MemoryManager();

// Initialize with file persistence
await memory.initialize('./memory-data');

// Add facts directly
await memory.addImmediateMemory('User is a TypeScript developer', 'professional');
await memory.addImmediateMemory('User prefers dark mode', 'preference');

// Duplicates are caught automatically
await memory.addImmediateMemory('User likes dark mode in all apps', 'preference');
// ^ Not stored — Jaccard similarity >= 0.8 with existing entry

// Build context for LLM system prompt
const context = memory.buildMemoryContext();
// ## What You Know About the User
// - User is a TypeScript developer
// - User prefers dark mode
```

### AI-Powered Extraction

```typescript
const memory = new MemoryManager();

// Provide your own LLM extraction function
await memory.initialize('./memory-data', async (prompt) => {
  // Call any LLM — Anthropic, OpenAI, local models, etc.
  const response = await myLLM.complete(prompt);
  return JSON.parse(response);
});

// Extract memories from conversation
await memory.extractMemories([
  { role: 'user', content: 'My coworker Sarah recommended the new TypeScript handbook' },
  { role: 'assistant', content: 'Great recommendation! Sarah has good taste.' },
]);
// Automatically extracts:
//   longTerm: [{ fact: "Coworker Sarah recommended TypeScript handbook", category: "relationship" }]
//   personMentions: [{ name: "Sarah", context: "recommended TypeScript handbook", sentiment: 0.6 }]
```

### Episodic Memory

```typescript
import { EpisodicMemoryStore } from 'cognitive-memory';

const episodic = new EpisodicMemoryStore();

await episodic.initialize('./memory-data', async (transcript) => {
  // Your LLM analyzes the transcript
  const analysis = await myLLM.analyze(transcript);
  return {
    summary: analysis.summary,
    topics: analysis.topics,
    emotionalTone: analysis.tone,
    keyDecisions: analysis.decisions,
  };
});

// Record a session
const episode = await episodic.createFromSession(
  [
    { role: 'user', text: 'Help me plan the Q4 roadmap' },
    { role: 'assistant', text: "Let's start with priorities..." },
  ],
  startTime,
  endTime,
);

// Search past episodes
const results = episodic.search('roadmap');

// Context for LLM prompts
const context = episodic.getContextString();
// ## Recent Conversations
// - 2h ago: Discussed Q4 roadmap priorities [planning, strategy]
// - yesterday: Reviewed pull request for auth module [code-review, auth]
```

### Relationship Tracking

```typescript
import { RelationshipMemory } from 'cognitive-memory';

const relationship = new RelationshipMemory();

await relationship.initialize('./memory-data', async (transcript, existingJokes) => {
  // Your LLM extracts relationship dynamics
  return await myLLM.analyzeRelationship(transcript, existingJokes);
});

// Update from an episode
await relationship.updateFromEpisode(episode);

const state = relationship.getState();
// state.trustLevel → 0.52
// state.currentStreak → 4
// state.insideJokes → ["the infamous semicolon debate"]
// state.favouriteTopics → [{ topic: "TypeScript", count: 12 }]

// Context for LLM prompts
const context = relationship.getContextString('Alex');
// ## Relationship Context
// - 45 conversations over 30 days (380 total minutes)
// - Current streak: 4 consecutive days
// - Growing familiarity — Alex is becoming comfortable with your style
// - Most discussed topics: TypeScript, React, architecture
// - Inside jokes/references you share: the infamous semicolon debate
```

### Sleep-Like Consolidation

```typescript
import { MemoryManager, MemoryConsolidation, EpisodicMemoryStore } from 'cognitive-memory';

const memory = new MemoryManager();
const episodic = new EpisodicMemoryStore();

// ... initialize both ...

const consolidation = new MemoryConsolidation(memory, {
  episodic,
  mergeFn: async (facts) => {
    // Your LLM merges duplicate facts into one
    return await myLLM.mergeFacts(facts);
  },
  insightFn: async (summaries, existingFacts) => {
    // Your LLM finds cross-episode patterns
    return await myLLM.findInsights(summaries, existingFacts);
  },
  config: {
    intervalMs: 6 * 60 * 60 * 1000, // Every 6 hours
    promotionScoreThreshold: 10,
    promotionMinOccurrences: 3,
  },
});

// Start automatic consolidation
consolidation.start();

// Or run on demand
const result = await consolidation.run();
// { promoted: 2, merged: 1, insights: 1 }
```

## In-Memory Mode (No Filesystem)

All components support in-memory initialization for browser environments, testing, or serverless:

```typescript
const memory = new MemoryManager();
memory.initializeFromData({
  longTerm: existingFacts,
  mediumTerm: existingObservations,
});

const episodic = new EpisodicMemoryStore();
episodic.initializeFromData(existingEpisodes);

const relationship = new RelationshipMemory();
relationship.initializeFromData(existingState);
```

## API Reference

### MemoryManager

| Method | Description |
|--------|-------------|
| `initialize(path, extractor?, hooks?)` | Load from disk, configure AI extractor and hooks |
| `initializeFromData(data, extractor?, hooks?)` | Load from existing data (no filesystem) |
| `extractMemories(conversation)` | AI-powered memory extraction from conversation |
| `addImmediateMemory(fact, category)` | Directly add a long-term fact (with dedup) |
| `updateLongTermEntry(id, updates)` | Update an existing long-term entry |
| `deleteLongTermEntry(id)` | Delete a long-term entry |
| `deleteMediumTermEntry(id)` | Delete a medium-term entry |
| `buildMemoryContext()` | Markdown context for LLM system prompt |
| `isDuplicateFact(fact, existing)` | Jaccard similarity check (>= 0.8) |
| `exportData()` | Export full memory store |
| `flush()` | Force save pending writes |

### EpisodicMemoryStore

| Method | Description |
|--------|-------------|
| `initialize(path, analyzer?, hooks?)` | Load from disk, configure AI analyzer |
| `initializeFromData(episodes, analyzer?, hooks?)` | Load from existing data |
| `createFromSession(transcript, start, end, labels?)` | Create episode from conversation |
| `search(query, maxResults?)` | Weighted search across episodes |
| `getRecent(count?)` | Get most recent episodes |
| `getById(id)` | Find episode by ID |
| `deleteEpisode(id)` | Delete an episode |
| `getContextString()` | Markdown context for LLM prompt |
| `exportData()` | Export episodes (without transcripts) |

### RelationshipMemory

| Method | Description |
|--------|-------------|
| `initialize(path, analyzer?)` | Load from disk, configure AI analyzer |
| `initializeFromData(state, analyzer?)` | Load from existing data |
| `updateFromEpisode(episode, labels?)` | Update relationship from episode |
| `getState()` | Get current relationship state |
| `getContextString(userName?)` | Markdown context for LLM prompt |
| `exportData()` | Export relationship state |

### MemoryConsolidation

| Method | Description |
|--------|-------------|
| `new MemoryConsolidation(memory, options?)` | Create with memory manager and optional integrations |
| `start()` | Begin automatic periodic consolidation |
| `stop()` | Stop automatic consolidation |
| `run()` | Run a single consolidation cycle |
| `computePromotionScore(entry)` | Calculate weighted promotion score (exported) |

## Origin

This memory system was built as part of [Agent Friday](https://github.com/FutureSpeakAI/Agent-Friday), the world's first AGI OS, by [FutureSpeak.AI](https://futurespeak.ai) in Austin, Texas.

The core insight — that AI agents need human-like cognitive architecture, not just flat fact storage — emerged from building a personal AI assistant that needed to remember context across sessions, notice patterns over time, consolidate what it learned during "downtime", and build a genuine relationship with its user.

## License

MIT — see [LICENSE](./LICENSE)

---

**Built with conviction by [FutureSpeak.AI](https://futurespeak.ai)**
