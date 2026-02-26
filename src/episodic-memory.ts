/**
 * episodic-memory.ts — Episodic Memory Store
 *
 * Records timestamped session episodes with AI-generated summaries,
 * topics, emotional tone, and key decisions. Provides weighted search
 * across summary, topics, decisions, and transcript with recency boosting.
 *
 * Extracted from Agent Friday (https://github.com/FutureSpeakAI/Agent-Friday)
 * — the AGI OS by FutureSpeak.AI
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// ── Interfaces ───────────────────────────────────────────────────────

export interface Episode {
  id: string;
  startTime: number;
  endTime: number;
  durationSeconds: number;
  summary: string;
  topics: string[];
  emotionalTone: string;
  keyDecisions: string[];
  turnCount: number;
  /** Raw transcript lines — kept for search but optional for storage */
  transcript?: Array<{ role: string; text: string }>;
}

export interface EpisodeAnalysis {
  summary: string;
  topics: string[];
  emotionalTone: string;
  keyDecisions: string[];
}

/**
 * AI function for analyzing a conversation transcript into an episode.
 * Takes the transcript text and returns structured analysis.
 */
export type EpisodeAnalyzerFn = (transcriptText: string) => Promise<EpisodeAnalysis>;

/**
 * Optional hooks for integration with external systems.
 */
export interface EpisodicHooks {
  /** Called after a new episode is created */
  onEpisodeCreated?: (episode: Episode) => void;
  /** Called after an episode is deleted */
  onEpisodeDeleted?: (id: string) => void;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_EPISODES = 200;
const MIN_SESSION_SECONDS = 60;

// ── EpisodicMemoryStore Class ────────────────────────────────────────

export class EpisodicMemoryStore {
  private episodes: Episode[] = [];
  private storageDir: string = '';
  private initialized = false;
  private analyzer: EpisodeAnalyzerFn | null = null;
  private hooks: EpisodicHooks = {};

  /**
   * Initialize with file persistence.
   * @param storagePath — Directory to store episodes.json
   * @param analyzer — Optional AI function for episode analysis
   * @param hooks — Optional integration hooks
   */
  async initialize(
    storagePath: string,
    analyzer?: EpisodeAnalyzerFn,
    hooks?: EpisodicHooks,
  ): Promise<void> {
    this.storageDir = storagePath;
    if (analyzer) this.analyzer = analyzer;
    if (hooks) this.hooks = hooks;

    await fs.mkdir(this.storageDir, { recursive: true });
    await this.load();
    this.initialized = true;
    console.log(`[EpisodicMemory] Loaded ${this.episodes.length} episodes`);
  }

  /**
   * Initialize from pre-existing data (no filesystem).
   */
  initializeFromData(
    episodes: Episode[],
    analyzer?: EpisodeAnalyzerFn,
    hooks?: EpisodicHooks,
  ): void {
    this.episodes = episodes;
    if (analyzer) this.analyzer = analyzer;
    if (hooks) this.hooks = hooks;
    this.initialized = true;
  }

  // ── Getters ──────────────────────────────────────────────────────

  getAll(): Episode[] {
    return this.episodes;
  }

  getById(id: string): Episode | undefined {
    return this.episodes.find((e) => e.id === id);
  }

  getRecent(count = 5): Episode[] {
    return this.episodes.slice(-count);
  }

  exportData(): Episode[] {
    return this.episodes.map((ep) => ({ ...ep, transcript: undefined }));
  }

  // ── Episode Creation ─────────────────────────────────────────────

  /**
   * Create an episode from a completed conversation session.
   * Uses the configured AI analyzer to generate summary, topics, emotional tone,
   * and key decisions.
   */
  async createFromSession(
    transcript: Array<{ role: string; text: string }>,
    startTime: number,
    endTime: number,
    labels?: { userName?: string; agentName?: string },
  ): Promise<Episode | null> {
    const durationSeconds = Math.round((endTime - startTime) / 1000);

    if (durationSeconds < MIN_SESSION_SECONDS) {
      console.log(`[EpisodicMemory] Session too short (${durationSeconds}s), skipping`);
      return null;
    }

    if (transcript.length < 2) {
      console.log('[EpisodicMemory] Too few turns, skipping');
      return null;
    }

    const turnCount = transcript.length;
    const userName = labels?.userName || 'User';
    const agentName = labels?.agentName || 'Agent';

    // Build conversation text for analysis
    const conversationText = transcript
      .map((t) => `${t.role === 'user' ? userName : agentName}: ${t.text}`)
      .join('\n');

    // Truncate if extremely long (keep last ~8k chars)
    const maxChars = 8000;
    const trimmedConversation =
      conversationText.length > maxChars
        ? '... [earlier conversation truncated] ...\n' + conversationText.slice(-maxChars)
        : conversationText;

    let summary = '';
    let topics: string[] = [];
    let emotionalTone = 'neutral';
    let keyDecisions: string[] = [];

    if (this.analyzer) {
      try {
        const analysis = await this.analyzer(trimmedConversation);
        summary = analysis.summary || '';
        topics = analysis.topics || [];
        emotionalTone = analysis.emotionalTone || 'neutral';
        keyDecisions = analysis.keyDecisions || [];
      } catch (err) {
        console.warn('[EpisodicMemory] AI analysis failed, using fallback:', err);
        const firstUser = transcript.find((t) => t.role === 'user');
        summary = firstUser
          ? `Session about: ${firstUser.text.slice(0, 100)}...`
          : `${turnCount}-turn conversation session`;
      }
    } else {
      // No analyzer — basic fallback
      const firstUser = transcript.find((t) => t.role === 'user');
      summary = firstUser
        ? `Session about: ${firstUser.text.slice(0, 100)}...`
        : `${turnCount}-turn conversation session`;
    }

    const episode: Episode = {
      id: crypto.randomUUID(),
      startTime,
      endTime,
      durationSeconds,
      summary,
      topics,
      emotionalTone,
      keyDecisions,
      turnCount,
      transcript,
    };

    this.episodes.push(episode);

    if (this.episodes.length > MAX_EPISODES) {
      this.episodes = this.episodes.slice(-MAX_EPISODES);
    }

    await this.save();

    this.hooks.onEpisodeCreated?.(episode);

    console.log(
      `[EpisodicMemory] Created episode ${episode.id.slice(0, 8)}: "${summary.slice(0, 80)}..."`
    );

    return episode;
  }

  // ── Search ───────────────────────────────────────────────────────

  /**
   * Search episodes by text query with weighted scoring.
   *
   * Weight distribution:
   *   Summary match:    10 points
   *   Topic match:       5 points (per topic)
   *   Key decision:      4 points (per decision)
   *   Transcript match:  1 point  (once per episode)
   *   Recency bonus:    +3 if < 24h, +1 if < 1 week
   */
  search(query: string, maxResults = 10): Episode[] {
    const q = query.toLowerCase();

    const scored = this.episodes
      .map((ep) => {
        let score = 0;

        if (ep.summary.toLowerCase().includes(q)) score += 10;

        for (const topic of ep.topics) {
          if (topic.toLowerCase().includes(q)) score += 5;
        }

        for (const decision of ep.keyDecisions) {
          if (decision.toLowerCase().includes(q)) score += 4;
        }

        if (ep.transcript) {
          for (const turn of ep.transcript) {
            if (turn.text.toLowerCase().includes(q)) {
              score += 1;
              break;
            }
          }
        }

        // Recency bonus
        const ageHours = (Date.now() - ep.endTime) / (1000 * 60 * 60);
        if (ageHours < 24) score += 3;
        else if (ageHours < 168) score += 1;

        return { episode: ep, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return scored.map((s) => s.episode);
  }

  // ── Delete ───────────────────────────────────────────────────────

  async deleteEpisode(id: string): Promise<boolean> {
    const before = this.episodes.length;
    this.episodes = this.episodes.filter((e) => e.id !== id);

    if (this.episodes.length < before) {
      await this.save();
      this.hooks.onEpisodeDeleted?.(id);
      return true;
    }
    return false;
  }

  // ── Context Generation ───────────────────────────────────────────

  /**
   * Build a context string showing recent episodes for LLM system prompt injection.
   */
  getContextString(): string {
    const recent = this.getRecent(5);
    if (recent.length === 0) return '';

    const lines = recent.map((ep) => {
      const when = this.formatTimeAgo(ep.endTime);
      const topics = ep.topics.length > 0 ? ` [${ep.topics.join(', ')}]` : '';
      return `- ${when}: ${ep.summary}${topics}`;
    });

    return `## Recent Conversations\n${lines.join('\n')}`;
  }

  // ── Persistence ──────────────────────────────────────────────────

  async flush(): Promise<void> {
    await this.save();
  }

  private formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  private async save(): Promise<void> {
    if (!this.storageDir) return;
    const filePath = path.join(this.storageDir, 'episodes.json');
    // Strip transcripts for storage efficiency
    const stripped = this.episodes.map((ep) => ({ ...ep, transcript: undefined }));
    await fs.writeFile(filePath, JSON.stringify(stripped, null, 2), 'utf-8');
  }

  private async load(): Promise<void> {
    const filePath = path.join(this.storageDir, 'episodes.json');
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      this.episodes = JSON.parse(data);
    } catch {
      // File doesn't exist yet
    }
  }
}
