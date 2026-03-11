/**
 * memory-manager.ts — Three-Tier Memory System
 *
 * AI-powered memory extraction with Jaccard deduplication.
 * Short-term (conversation buffer), medium-term (patterns/observations),
 * and long-term (confirmed facts) — mirroring human cognitive architecture.
 *
 * Extracted from Agent Friday (https://github.com/FutureSpeakAI/Agent-Friday)
 * — the world's most trustworthy AI assistant, by FutureSpeak.AI
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// ── Interfaces ───────────────────────────────────────────────────────

export interface ShortTermEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface MediumTermEntry {
  id: string;
  observation: string;
  category: 'preference' | 'pattern' | 'context';
  confidence: number;
  firstObserved: number;
  lastReinforced: number;
  occurrences: number;
  /** How many distinct sessions reinforced this observation */
  sessionCount?: number;
}

export interface LongTermEntry {
  id: string;
  fact: string;
  category: 'identity' | 'preference' | 'relationship' | 'professional';
  confirmed: boolean;
  createdAt: number;
  source: 'extracted' | 'user-stated' | 'manual-edit';
}

export interface MemoryStore {
  shortTerm: ShortTermEntry[];
  mediumTerm: MediumTermEntry[];
  longTerm: LongTermEntry[];
}

export interface ExtractionResult {
  longTerm: Array<{ fact: string; category: string }>;
  mediumTerm: Array<{ observation: string; category: string }>;
  personMentions?: Array<{
    name: string;
    context: string;
    sentiment: number;
    domains?: string[];
    evidenceType?: string;
  }>;
}

/**
 * Function signature for the AI extraction callback.
 * You provide a function that takes a prompt and returns structured extraction results.
 * This decouples the memory system from any specific LLM provider.
 */
export type ExtractorFn = (prompt: string) => Promise<ExtractionResult>;

/**
 * Optional hooks for integration with external systems.
 */
export interface MemoryHooks {
  /** Called when a new long-term fact is stored */
  onLongTermAdded?: (entry: LongTermEntry) => void;
  /** Called when a medium-term observation is stored or reinforced */
  onMediumTermUpdated?: (entry: MediumTermEntry) => void;
  /** Called when person mentions are extracted from conversation */
  onPersonMentions?: (mentions: ExtractionResult['personMentions']) => void;
  /** Called after any tier is saved to disk */
  onSaved?: (tier: 'shortTerm' | 'mediumTerm' | 'longTerm') => void;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_SHORT_TERM = 20;
const MEDIUM_TERM_MAX_AGE_DAYS = 30;
const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes

// ── Stop words for Jaccard dedup ─────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'and', 'but',
  'or', 'not', 'no', 'so', 'if', 'than', 'that', 'this', 'it', 'its', 'they', 'them',
  'their', 'he', 'she', 'his', 'her', 'we', 'us', 'our', 'you', 'your', 'i', 'my', 'me',
]);

// ── MemoryManager Class ──────────────────────────────────────────────

export class MemoryManager {
  private memoryDir: string = '';
  private store: MemoryStore = { shortTerm: [], mediumTerm: [], longTerm: [] };
  private initialized = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private extractor: ExtractorFn | null = null;
  private hooks: MemoryHooks = {};

  /**
   * Initialize the memory manager with file persistence.
   * @param storagePath — Directory to store memory JSON files
   * @param extractor — Optional AI extraction function
   * @param hooks — Optional integration hooks
   */
  async initialize(storagePath: string, extractor?: ExtractorFn, hooks?: MemoryHooks): Promise<void> {
    this.memoryDir = storagePath;
    if (extractor) this.extractor = extractor;
    if (hooks) this.hooks = hooks;

    await fs.mkdir(this.memoryDir, { recursive: true });
    await this.load();
    this.pruneExpired();
    this.initialized = true;
  }

  /**
   * Initialize from pre-existing data (no filesystem).
   * Useful for browser environments, testing, or serverless.
   */
  initializeFromData(
    data: Partial<MemoryStore>,
    extractor?: ExtractorFn,
    hooks?: MemoryHooks,
  ): void {
    if (data.shortTerm) this.store.shortTerm = data.shortTerm;
    if (data.mediumTerm) this.store.mediumTerm = data.mediumTerm;
    if (data.longTerm) this.store.longTerm = data.longTerm;
    if (extractor) this.extractor = extractor;
    if (hooks) this.hooks = hooks;
    this.pruneExpired();
    this.initialized = true;
  }

  // ── Getters ──────────────────────────────────────────────────────

  getShortTerm(): ShortTermEntry[] {
    return this.store.shortTerm;
  }

  getMediumTerm(): MediumTermEntry[] {
    return this.store.mediumTerm;
  }

  getLongTerm(): LongTermEntry[] {
    return this.store.longTerm;
  }

  exportData(): MemoryStore {
    return JSON.parse(JSON.stringify(this.store));
  }

  // ── Short-Term Operations ────────────────────────────────────────

  async updateShortTerm(messages: Array<{ role: string; content: string }>): Promise<void> {
    this.store.shortTerm = messages.slice(-MAX_SHORT_TERM).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: Date.now(),
    }));
    await this.save('shortTerm');
  }

  async addShortTermEntry(entry: ShortTermEntry): Promise<void> {
    this.store.shortTerm.push(entry);
    if (this.store.shortTerm.length > MAX_SHORT_TERM) {
      this.store.shortTerm = this.store.shortTerm.slice(-MAX_SHORT_TERM);
    }
    await this.save('shortTerm');
  }

  // ── AI-Powered Extraction ────────────────────────────────────────

  /**
   * Extract memories from a conversation using the configured AI extractor.
   * Automatically deduplicates against existing memories using Jaccard similarity.
   */
  async extractMemories(conversationHistory: Array<{ role: string; content: string }>): Promise<void> {
    if (conversationHistory.length < 2) return;
    if (!this.extractor) {
      console.warn('[Memory] No extractor configured, skipping extraction');
      return;
    }

    const existingLongTerm = this.store.longTerm.map((e) => `- ${e.fact}`).join('\n') || 'None yet';
    const existingMediumTerm = this.store.mediumTerm.map((e) => `- ${e.observation}`).join('\n') || 'None yet';

    const conversationText = conversationHistory
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const prompt = `Analyse this conversation and extract useful information about the user. Return ONLY valid JSON with no other text.

CONVERSATION:
${conversationText}

ALREADY KNOWN (long-term facts):
${existingLongTerm}

ALREADY KNOWN (medium-term patterns):
${existingMediumTerm}

Return JSON in this exact format (include only genuinely NEW information not already listed above):
{
  "longTerm": [{"fact": "string", "category": "identity|preference|relationship|professional"}],
  "mediumTerm": [{"observation": "string", "category": "preference|pattern|context"}],
  "personMentions": [
    {
      "name": "person's name (as mentioned)",
      "context": "brief description of what was said about or involving them",
      "sentiment": 0.0,
      "domains": ["optional", "expertise", "areas"],
      "evidenceType": "observed"
    }
  ]
}

personMentions: Extract any people mentioned in the conversation (not the user themselves). Include:
- Their name as mentioned
- Brief context of what was discussed about them
- Sentiment from -1 (very negative) to +1 (very positive), 0 for neutral
- Any domains of expertise implied (e.g. "typescript", "cooking", "finance")
- Evidence type: "promise_kept", "promise_broken", "accurate_info", "inaccurate_info", "helpful_action", "unhelpful_action", "emotional_support", "user_stated", "observed", or "inferred"

If nothing new to extract, return: {"longTerm": [], "mediumTerm": [], "personMentions": []}`;

    try {
      const extracted = await this.extractor(prompt);

      // Merge long-term entries
      if (Array.isArray(extracted.longTerm)) {
        for (const item of extracted.longTerm) {
          if (!item.fact || typeof item.fact !== 'string') continue;
          const exists = this.isDuplicateFact(item.fact, this.store.longTerm.map((e) => e.fact));
          if (!exists) {
            const entry: LongTermEntry = {
              id: crypto.randomUUID(),
              fact: item.fact,
              category: (item.category as LongTermEntry['category']) || 'identity',
              confirmed: false,
              createdAt: Date.now(),
              source: 'extracted',
            };
            this.store.longTerm.push(entry);
            this.hooks.onLongTermAdded?.(entry);
          }
        }
        await this.save('longTerm');
      }

      // Merge medium-term entries
      if (Array.isArray(extracted.mediumTerm)) {
        for (const item of extracted.mediumTerm) {
          if (!item.observation || typeof item.observation !== 'string') continue;
          const existing = this.store.mediumTerm.find(
            (e) => this.isDuplicateFact(item.observation, [e.observation])
          );
          if (existing) {
            existing.occurrences++;
            // Detect new session: if >30 min since last reinforcement
            if (Date.now() - existing.lastReinforced > SESSION_GAP_MS) {
              existing.sessionCount = (existing.sessionCount || 1) + 1;
            }
            existing.lastReinforced = Date.now();
            existing.confidence = Math.min(1, existing.confidence + 0.1);
            this.hooks.onMediumTermUpdated?.(existing);
          } else {
            const entry: MediumTermEntry = {
              id: crypto.randomUUID(),
              observation: item.observation,
              category: (item.category as MediumTermEntry['category']) || 'pattern',
              confidence: 0.5,
              firstObserved: Date.now(),
              lastReinforced: Date.now(),
              occurrences: 1,
              sessionCount: 1,
            };
            this.store.mediumTerm.push(entry);
            this.hooks.onMediumTermUpdated?.(entry);
          }
        }
        await this.save('mediumTerm');
      }

      // Route person mentions via hook
      if (Array.isArray(extracted.personMentions) && extracted.personMentions.length > 0) {
        this.hooks.onPersonMentions?.(extracted.personMentions);
      }

      console.log(
        `[Memory] Extracted ${extracted.longTerm?.length || 0} long-term, ` +
        `${extracted.mediumTerm?.length || 0} medium-term, ` +
        `${extracted.personMentions?.length || 0} person mentions`
      );
    } catch (err) {
      console.warn('[Memory] Extraction failed:', err);
    }
  }

  // ── Direct Memory Operations ─────────────────────────────────────

  /** Directly add a long-term fact (bypasses AI extraction). */
  async addImmediateMemory(fact: string, category: string): Promise<void> {
    const validCategories = ['identity', 'preference', 'relationship', 'professional'];
    const cat = validCategories.includes(category) ? category : 'identity';

    const exists = this.isDuplicateFact(fact, this.store.longTerm.map((e) => e.fact));

    if (!exists) {
      const entry: LongTermEntry = {
        id: crypto.randomUUID(),
        fact,
        category: cat as LongTermEntry['category'],
        confirmed: true,
        createdAt: Date.now(),
        source: 'user-stated',
      };
      this.store.longTerm.push(entry);
      await this.save('longTerm');
      this.hooks.onLongTermAdded?.(entry);
      console.log(`[Memory] Immediate save: "${fact}" (${cat})`);
    }
  }

  async updateLongTermEntry(id: string, updates: Partial<LongTermEntry>): Promise<void> {
    const entry = this.store.longTerm.find((e) => e.id === id);
    if (entry) {
      Object.assign(entry, updates);
      await this.save('longTerm');
    }
  }

  async deleteLongTermEntry(id: string): Promise<void> {
    this.store.longTerm = this.store.longTerm.filter((e) => e.id !== id);
    await this.save('longTerm');
  }

  async deleteMediumTermEntry(id: string): Promise<void> {
    this.store.mediumTerm = this.store.mediumTerm.filter((e) => e.id !== id);
    await this.save('mediumTerm');
  }

  // ── Context Generation ───────────────────────────────────────────

  /** Build a markdown context string suitable for LLM system prompt injection. */
  buildMemoryContext(): string {
    const parts: string[] = [];

    if (this.store.longTerm.length > 0) {
      const facts = this.store.longTerm.map((e) => `- ${e.fact}`).join('\n');
      parts.push(`## What You Know About the User\n${facts}`);
    }

    if (this.store.mediumTerm.length > 0) {
      const observations = this.store.mediumTerm
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, 10)
        .map((e) => `- ${e.observation}`)
        .join('\n');
      parts.push(`## Recent Observations\n${observations}`);
    }

    return parts.join('\n\n');
  }

  // ── Jaccard Deduplication ────────────────────────────────────────

  /**
   * Check if a fact is a duplicate of any existing facts using word-overlap similarity.
   * Uses Jaccard similarity with stop-word filtering — requires >= 80% overlap
   * to be considered a duplicate. This avoids the substring matching bug where
   * "he" matches "she likes cheese".
   */
  isDuplicateFact(newFact: string, existingFacts: string[]): boolean {
    const tokenize = (text: string): Set<string> => {
      const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
      return new Set(words.filter((w) => !STOP_WORDS.has(w) && w.length > 2));
    };

    const newWords = tokenize(newFact);
    if (newWords.size === 0) return false;

    for (const existing of existingFacts) {
      const existingWords = tokenize(existing);
      if (existingWords.size === 0) continue;

      // Compute Jaccard similarity (intersection / union)
      let intersection = 0;
      for (const word of newWords) {
        if (existingWords.has(word)) intersection++;
      }
      const union = new Set([...newWords, ...existingWords]).size;
      const similarity = intersection / union;

      if (similarity >= 0.8) return true;
    }

    return false;
  }

  // ── Persistence ──────────────────────────────────────────────────

  /** Force flush all pending saves. */
  async flush(): Promise<void> {
    await this.saveQueue;
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - MEDIUM_TERM_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const before = this.store.mediumTerm.length;
    this.store.mediumTerm = this.store.mediumTerm.filter(
      (e) => e.lastReinforced > cutoff || e.occurrences >= 5
    );
    if (this.store.mediumTerm.length < before) {
      console.log(`[Memory] Pruned ${before - this.store.mediumTerm.length} expired medium-term entries`);
    }

    if (this.store.shortTerm.length > MAX_SHORT_TERM) {
      this.store.shortTerm = this.store.shortTerm.slice(-MAX_SHORT_TERM);
    }
  }

  private async save(tier: 'shortTerm' | 'mediumTerm' | 'longTerm'): Promise<void> {
    if (!this.memoryDir) return; // In-memory mode

    this.saveQueue = this.saveQueue.then(async () => {
      const filePath = path.join(this.memoryDir, `${tier}.json`);
      await fs.writeFile(filePath, JSON.stringify(this.store[tier], null, 2), 'utf-8');
      this.hooks.onSaved?.(tier);
    }).catch((err) => {
      console.error(`[Memory] Save failed for ${tier}:`, err);
    });
    return this.saveQueue;
  }

  private async load(): Promise<void> {
    for (const tier of ['shortTerm', 'mediumTerm', 'longTerm'] as const) {
      const filePath = path.join(this.memoryDir, `${tier}.json`);
      try {
        const data = await fs.readFile(filePath, 'utf-8');
        (this.store as any)[tier] = JSON.parse(data);
      } catch {
        // File doesn't exist yet, keep defaults
      }
    }
  }
}
