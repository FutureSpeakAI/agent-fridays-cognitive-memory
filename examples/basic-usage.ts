/**
 * Basic usage example for cognitive-memory
 *
 * Run with: npx ts-node examples/basic-usage.ts
 */

import {
  MemoryManager,
  EpisodicMemoryStore,
  RelationshipMemory,
  MemoryConsolidation,
} from '../src';

async function main() {
  const storagePath = './example-memory-data';

  // ── 1. Core Memory Manager ──────────────────────────────────────

  const memory = new MemoryManager();

  // Initialize with file persistence and an AI extractor
  await memory.initialize(storagePath, async (prompt) => {
    // Replace with your actual LLM call (Anthropic, OpenAI, etc.)
    console.log('[Extractor] Would send prompt to LLM...');
    return { longTerm: [], mediumTerm: [], personMentions: [] };
  }, {
    onLongTermAdded: (entry) => {
      console.log(`[Hook] New long-term memory: ${entry.fact}`);
    },
    onPersonMentions: (mentions) => {
      console.log(`[Hook] Found ${mentions?.length} person mentions`);
    },
  });

  console.log('=== Cognitive Memory Demo ===\n');

  // --- Direct memory operations ---

  await memory.addImmediateMemory('User prefers dark mode in all applications', 'preference');
  await memory.addImmediateMemory('User is a senior TypeScript developer', 'professional');
  await memory.addImmediateMemory('User lives in Austin, Texas', 'identity');

  console.log('Long-term memories:');
  for (const entry of memory.getLongTerm()) {
    console.log(`  [${entry.category}] ${entry.fact}`);
  }
  console.log();

  // --- Jaccard deduplication ---

  await memory.addImmediateMemory('User prefers dark mode across all apps', 'preference');
  console.log(`After adding near-duplicate: ${memory.getLongTerm().length} entries (deduped!)\n`);

  // --- AI extraction from conversation ---

  await memory.extractMemories([
    { role: 'user', content: 'Can you help me with my React project?' },
    { role: 'assistant', content: 'Of course! What are you building?' },
    { role: 'user', content: 'A dashboard for our fintech startup. Sarah suggested using Recharts.' },
    { role: 'assistant', content: "Great choice — Recharts works well for financial data." },
  ]);

  // --- Context generation for LLM prompts ---

  console.log('Memory context for system prompt:');
  console.log(memory.buildMemoryContext());
  console.log();

  // ── 2. Episodic Memory ──────────────────────────────────────────

  const episodic = new EpisodicMemoryStore();

  await episodic.initialize(storagePath, async (transcript) => {
    // Replace with your actual LLM call
    return {
      summary: 'Discussed React dashboard for fintech startup using Recharts',
      topics: ['React', 'fintech', 'data visualization'],
      emotionalTone: 'focused',
      keyDecisions: ['Use Recharts for charts'],
    };
  }, {
    onEpisodeCreated: (episode) => {
      console.log(`[Hook] Episode created: ${episode.id.slice(0, 8)}`);
    },
  });

  // Create an episode from a conversation
  const episode = await episodic.createFromSession(
    [
      { role: 'user', text: 'Help me build a dashboard' },
      { role: 'assistant', text: 'Sure! What data do you need to visualize?' },
      { role: 'user', text: 'Revenue, user growth, and conversion rates' },
      { role: 'assistant', text: "I'll set up Recharts with those three panels." },
    ],
    Date.now() - 300000, // 5 minutes ago
    Date.now(),
    { userName: 'Developer', agentName: 'Friday' },
  );

  if (episode) {
    console.log(`\nEpisode: ${episode.summary}`);
    console.log(`Topics: ${episode.topics.join(', ')}`);
    console.log(`Tone: ${episode.emotionalTone}`);
  }

  // Search episodes
  const results = episodic.search('React');
  console.log(`\nSearch "React": ${results.length} episode(s) found`);

  // Context for prompts
  console.log('\nEpisodic context:');
  console.log(episodic.getContextString());
  console.log();

  // ── 3. Relationship Memory ──────────────────────────────────────

  const relationship = new RelationshipMemory();

  await relationship.initialize(storagePath, async (transcript, existingJokes) => {
    // Replace with your actual LLM call
    return {
      newInsideJokes: [],
      sharedReferences: ['Recharts'],
      communicationNotes: [{ trait: 'style', value: 'Direct and technical' }],
      moodSummary: 'focused',
    };
  });

  // Update from the episode we created
  if (episode) {
    await relationship.updateFromEpisode(episode, {
      userName: 'Developer',
      agentName: 'Friday',
    });
  }

  const state = relationship.getState();
  console.log('Relationship state:');
  console.log(`  Sessions: ${state.totalSessions}`);
  console.log(`  Trust level: ${(state.trustLevel * 100).toFixed(0)}%`);
  console.log(`  Current streak: ${state.currentStreak} days`);
  console.log();

  console.log('Relationship context:');
  console.log(relationship.getContextString('Developer'));
  console.log();

  // ── 4. Memory Consolidation ─────────────────────────────────────

  const consolidation = new MemoryConsolidation(memory, {
    episodic,
    config: { promotionScoreThreshold: 10, promotionMinOccurrences: 3 },
  });

  // Run a single consolidation cycle (normally runs every 6h)
  const result = await consolidation.run();
  console.log('Consolidation result:', result);

  // ── 5. Export ───────────────────────────────────────────────────

  console.log(`\nMemory store: ${memory.getLongTerm().length} long-term, ${memory.getMediumTerm().length} medium-term`);
  console.log(`Episodes: ${episodic.getAll().length}`);

  await memory.flush();
  await episodic.flush();
  await relationship.flush();
  console.log('All data saved.');
}

main().catch(console.error);
