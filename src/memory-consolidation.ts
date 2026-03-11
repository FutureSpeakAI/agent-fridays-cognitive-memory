/**
 * memory-consolidation.ts — Sleep-Like Memory Consolidation Engine
 *
 * Periodically strengthens important memories and prunes redundancy:
 *  1. Promotes high-scoring medium-term observations → long-term facts
 *  2. Merges duplicate/overlapping long-term entries via AI
 *  3. Extracts cross-episode insights from recent episodes
 *
 * Promotion uses a weighted scoring formula across frequency, cross-session
 * reinforcement, time-span persistence, confidence, and staleness decay —
 * inspired by how the brain's sleep consolidation strengthens important
 * memories and discards noise.
 *
 * Extracted from Agent Friday (https://github.com/FutureSpeakAI/Agent-Friday)
 * — the world's most trustworthy AI assistant, by FutureSpeak.AI
 */

import crypto from 'crypto';
import type { MemoryManager, MediumTermEntry, LongTermEntry } from './memory-manager';
import type { EpisodicMemoryStore, Episode } from './episodic-memory';

// ── Configuration ────────────────────────────────────────────────────

export interface ConsolidationConfig {
  /** Interval between automatic consolidation runs (ms). Default: 6 hours */
  intervalMs?: number;
  /** Minimum weighted score for promotion. Default: 10 */
  promotionScoreThreshold?: number;
  /** Minimum occurrence count for promotion. Default: 3 */
  promotionMinOccurrences?: number;
  /** Minimum similarity for merge detection (0-1). Default: 0.85 */
  mergeSimilarityThreshold?: number;
}

/**
 * AI function for merging duplicate entries.
 * Takes an array of facts and returns a single merged fact string.
 */
export type MergeFn = (facts: string[]) => Promise<string | null>;

/**
 * AI function for extracting cross-episode insights.
 * Takes episode summaries + existing facts, returns new insights.
 */
export type InsightFn = (
  episodeSummaries: string[],
  existingFacts: string[],
) => Promise<Array<{ fact: string; category: string }>>;

/**
 * Similarity search function for finding duplicate long-term entries.
 * Takes a query and returns similar entries with their IDs and scores.
 */
export type SimilaritySearchFn = (
  query: string,
  maxResults: number,
  minScore: number,
) => Promise<Array<{ id: string; score: number }>>;

// ── Weighted Promotion Scoring ───────────────────────────────────────

/**
 * Compute a weighted promotion score for a medium-term observation.
 *
 * Signals and weights:
 *   FREQUENCY:      min(occurrences, 10) x 2       — max 20
 *   CROSS-SESSION:  min(sessionCount, 5) x 2       — max 10
 *   TIME-SPAN:      +5 if spans >= 7 days, +3 if >= 3 days
 *   CONFIDENCE:     +3 if confidence >= 0.9
 *   STALENESS:      -5 if not reinforced in 14+ days, -2 if 7+ days
 */
export function computePromotionScore(entry: MediumTermEntry): number {
  const frequency = Math.min(entry.occurrences, 10) * 2;
  const sessions = Math.min(entry.sessionCount || 1, 5) * 2;

  const daySpan = (entry.lastReinforced - entry.firstObserved) / (24 * 60 * 60 * 1000);
  const timeSpan = daySpan >= 7 ? 5 : daySpan >= 3 ? 3 : 0;

  const confidenceBonus = entry.confidence >= 0.9 ? 3 : 0;

  const daysSinceReinforced = (Date.now() - entry.lastReinforced) / (24 * 60 * 60 * 1000);
  const stalenessPenalty = daysSinceReinforced > 14 ? -5 : daysSinceReinforced > 7 ? -2 : 0;

  return frequency + sessions + timeSpan + confidenceBonus + stalenessPenalty;
}

// ── MemoryConsolidation Class ────────────────────────────────────────

export class MemoryConsolidation {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private memory: MemoryManager;
  private episodic: EpisodicMemoryStore | null;
  private mergeFn: MergeFn | null;
  private insightFn: InsightFn | null;
  private similaritySearch: SimilaritySearchFn | null;
  private config: Required<ConsolidationConfig>;

  constructor(
    memory: MemoryManager,
    options?: {
      episodic?: EpisodicMemoryStore;
      mergeFn?: MergeFn;
      insightFn?: InsightFn;
      similaritySearch?: SimilaritySearchFn;
      config?: ConsolidationConfig;
    },
  ) {
    this.memory = memory;
    this.episodic = options?.episodic ?? null;
    this.mergeFn = options?.mergeFn ?? null;
    this.insightFn = options?.insightFn ?? null;
    this.similaritySearch = options?.similaritySearch ?? null;
    this.config = {
      intervalMs: options?.config?.intervalMs ?? 6 * 60 * 60 * 1000,
      promotionScoreThreshold: options?.config?.promotionScoreThreshold ?? 10,
      promotionMinOccurrences: options?.config?.promotionMinOccurrences ?? 3,
      mergeSimilarityThreshold: options?.config?.mergeSimilarityThreshold ?? 0.85,
    };
  }

  /** Start automatic periodic consolidation. */
  start(): void {
    // Run initial consolidation after a short delay
    setTimeout(() => {
      this.run().catch((err) => {
        console.warn('[Consolidation] Initial run failed:', err);
      });
    }, 30_000);

    this.timer = setInterval(() => {
      this.run().catch((err) => {
        console.warn('[Consolidation] Periodic run failed:', err);
      });
    }, this.config.intervalMs);

    console.log(`[Consolidation] Started — running every ${Math.round(this.config.intervalMs / 3600000)}h`);
  }

  /** Stop automatic consolidation. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run the full consolidation cycle.
   * Can be called manually (on-demand) or is called automatically by the timer.
   */
  async run(): Promise<{ promoted: number; merged: number; insights: number }> {
    if (this.running) {
      console.log('[Consolidation] Already running, skipping');
      return { promoted: 0, merged: 0, insights: 0 };
    }

    this.running = true;
    console.log('[Consolidation] Starting consolidation cycle...');

    try {
      const promoted = await this.promoteHighConfidence();
      const merged = await this.mergeDuplicates();
      const insights = await this.extractCrossEpisodeInsights();

      console.log(
        `[Consolidation] Complete — promoted: ${promoted}, merged: ${merged}, insights: ${insights}`
      );

      return { promoted, merged, insights };
    } finally {
      this.running = false;
    }
  }

  /**
   * Phase 1: Promote high-scoring medium-term observations to long-term facts.
   *
   * Uses a weighted scoring formula that considers frequency, cross-session
   * reinforcement, time-span persistence, confidence, and staleness decay.
   */
  private async promoteHighConfidence(): Promise<number> {
    const mediumTerm = this.memory.getMediumTerm();
    const longTerm = this.memory.getLongTerm();
    let promotedCount = 0;

    const scored = mediumTerm
      .map((m) => ({ entry: m, score: computePromotionScore(m) }))
      .filter(
        (s) =>
          s.score >= this.config.promotionScoreThreshold &&
          s.entry.occurrences >= this.config.promotionMinOccurrences
      )
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      console.log(
        `[Consolidation] ${scored.length} candidate(s) meet promotion threshold:`,
        scored.map((s) => `"${s.entry.observation.slice(0, 40)}..." score=${s.score}`).join(', ')
      );
    }

    for (const { entry: candidate, score } of scored) {
      const alreadyExists = longTerm.some(
        (lt) =>
          lt.fact.toLowerCase().includes(candidate.observation.toLowerCase()) ||
          candidate.observation.toLowerCase().includes(lt.fact.toLowerCase())
      );

      if (alreadyExists) {
        await this.memory.deleteMediumTermEntry(candidate.id);
        continue;
      }

      const category = this.mapMediumToLongCategory(candidate.category);
      await this.memory.addImmediateMemory(candidate.observation, category);
      await this.memory.deleteMediumTermEntry(candidate.id);

      promotedCount++;
      console.log(
        `[Consolidation] Promoted (score=${score}): "${candidate.observation.slice(0, 60)}..." -> long-term (${category})`
      );
    }

    return promotedCount;
  }

  /**
   * Phase 2: Merge duplicate/overlapping long-term entries.
   * Requires both a similarity search function and an AI merge function.
   */
  private async mergeDuplicates(): Promise<number> {
    if (!this.similaritySearch || !this.mergeFn) return 0;

    const longTerm = this.memory.getLongTerm();
    if (longTerm.length < 3) return 0;

    const mergeGroups: Array<{ entries: LongTermEntry[]; merged: string }> = [];
    const processed = new Set<string>();

    for (const entry of longTerm) {
      if (processed.has(entry.id)) continue;

      const similar = await this.similaritySearch(
        entry.fact,
        5,
        this.config.mergeSimilarityThreshold,
      );

      const siblings = similar
        .filter((s) => s.id !== entry.id && !processed.has(s.id))
        .map((s) => longTerm.find((lt) => lt.id === s.id))
        .filter((lt): lt is LongTermEntry => lt !== undefined);

      if (siblings.length === 0) continue;

      processed.add(entry.id);
      for (const sib of siblings) {
        processed.add(sib.id);
      }

      const allEntries = [entry, ...siblings];
      const merged = await this.mergeFn(allEntries.map((e) => e.fact));

      if (merged) {
        mergeGroups.push({ entries: allEntries, merged });
      }
    }

    let mergedCount = 0;
    for (const group of mergeGroups) {
      const [keep, ...remove] = group.entries;

      for (const entry of remove) {
        await this.memory.deleteLongTermEntry(entry.id);
      }

      await this.memory.updateLongTermEntry(keep.id, {
        fact: group.merged,
        confirmed: true,
      });

      mergedCount++;
      console.log(
        `[Consolidation] Merged ${group.entries.length} entries -> "${group.merged.slice(0, 60)}..."`
      );
    }

    return mergedCount;
  }

  /**
   * Phase 3: Extract cross-episode insights from recent episodes.
   * Requires both an episodic memory store and an AI insight function.
   */
  private async extractCrossEpisodeInsights(): Promise<number> {
    if (!this.episodic || !this.insightFn) return 0;

    const episodes = this.episodic.getRecent(10);
    if (episodes.length < 3) return 0;

    const existingFacts = this.memory.getLongTerm().map((e) => e.fact);

    try {
      const summaries = episodes.map(
        (ep) =>
          `[${new Date(ep.startTime).toLocaleDateString()}] ${ep.summary} ` +
          `(Topics: ${ep.topics.join(', ')}; Mood: ${ep.emotionalTone})`
      );

      const insights = await this.insightFn(summaries, existingFacts.slice(0, 20));
      let insightCount = 0;

      for (const insight of insights.slice(0, 3)) {
        if (!insight?.fact) continue;

        const exists = existingFacts.some(
          (f) =>
            f.toLowerCase().includes(insight.fact.toLowerCase()) ||
            insight.fact.toLowerCase().includes(f.toLowerCase())
        );

        if (!exists) {
          await this.memory.addImmediateMemory(insight.fact, insight.category || 'identity');
          insightCount++;
          console.log(`[Consolidation] New insight: "${insight.fact.slice(0, 60)}..."`);
        }
      }

      return insightCount;
    } catch (err) {
      console.warn('[Consolidation] Cross-episode analysis failed:', err);
      return 0;
    }
  }

  private mapMediumToLongCategory(
    mediumCat: string
  ): 'identity' | 'preference' | 'relationship' | 'professional' {
    switch (mediumCat) {
      case 'preference':
        return 'preference';
      case 'context':
        return 'professional';
      case 'pattern':
        return 'preference';
      default:
        return 'identity';
    }
  }
}
