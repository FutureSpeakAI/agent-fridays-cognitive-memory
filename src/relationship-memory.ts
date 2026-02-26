/**
 * relationship-memory.ts — AI-User Relationship Tracking
 *
 * Tracks the evolving relationship between an AI agent and its user:
 * interaction streaks, inside jokes, shared references, communication
 * preferences, trust level (logarithmic growth), favourite topics,
 * and peak activity hours.
 *
 * Trust formula: 0.3 + log10(sessions + 1) * 0.2 + min(streak * 0.02, 0.2)
 *
 * Extracted from Agent Friday (https://github.com/FutureSpeakAI/Agent-Friday)
 * — the AGI OS by FutureSpeak.AI
 */

import fs from 'fs/promises';
import path from 'path';
import type { Episode } from './episodic-memory';

// ── Interfaces ───────────────────────────────────────────────────────

export interface SharedReference {
  reference: string;
  context: string;
  firstMentioned: number;
  lastMentioned: number;
  count: number;
}

export interface CommunicationPreference {
  trait: string;
  value: string;
  confidence: number;
  observedAt: number;
}

export interface RelationshipState {
  totalSessions: number;
  totalDurationMinutes: number;
  firstInteraction: number;
  lastInteraction: number;
  insideJokes: string[];
  sharedReferences: SharedReference[];
  communicationPreferences: CommunicationPreference[];
  trustLevel: number;
  averageMood: string;
  favouriteTopics: Array<{ topic: string; count: number }>;
  peakHours: number[];
  longestStreak: number;
  currentStreak: number;
  lastStreakDate: string;
}

/**
 * AI function for analyzing episode transcripts for relationship dynamics.
 * Takes transcript text + existing inside jokes, returns structured insights.
 */
export interface RelationshipAnalysis {
  newInsideJokes: string[];
  sharedReferences: string[];
  communicationNotes: Array<{ trait: string; value: string }>;
  moodSummary: string;
}

export type RelationshipAnalyzerFn = (
  transcriptText: string,
  existingInsideJokes: string[],
) => Promise<RelationshipAnalysis>;

// ── Constants ────────────────────────────────────────────────────────

const DEFAULTS: RelationshipState = {
  totalSessions: 0,
  totalDurationMinutes: 0,
  firstInteraction: 0,
  lastInteraction: 0,
  insideJokes: [],
  sharedReferences: [],
  communicationPreferences: [],
  trustLevel: 0.3,
  averageMood: 'neutral',
  favouriteTopics: [],
  peakHours: [],
  longestStreak: 0,
  currentStreak: 0,
  lastStreakDate: '',
};

// ── RelationshipMemory Class ─────────────────────────────────────────

export class RelationshipMemory {
  private state: RelationshipState = { ...DEFAULTS };
  private storageDir = '';
  private initialized = false;
  private analyzer: RelationshipAnalyzerFn | null = null;

  /**
   * Initialize with file persistence.
   * @param storagePath — Directory to store relationship.json
   * @param analyzer — Optional AI function for relationship analysis
   */
  async initialize(storagePath: string, analyzer?: RelationshipAnalyzerFn): Promise<void> {
    this.storageDir = storagePath;
    if (analyzer) this.analyzer = analyzer;

    await fs.mkdir(this.storageDir, { recursive: true });
    await this.load();
    this.initialized = true;
    console.log(
      `[RelationshipMemory] Loaded — ${this.state.totalSessions} sessions, ` +
      `trust: ${this.state.trustLevel.toFixed(2)}, streak: ${this.state.currentStreak}d`
    );
  }

  /**
   * Initialize from pre-existing data (no filesystem).
   */
  initializeFromData(state: Partial<RelationshipState>, analyzer?: RelationshipAnalyzerFn): void {
    this.state = { ...DEFAULTS, ...state };
    if (analyzer) this.analyzer = analyzer;
    this.initialized = true;
  }

  // ── Getters ──────────────────────────────────────────────────────

  getState(): RelationshipState {
    return { ...this.state };
  }

  exportData(): RelationshipState {
    return JSON.parse(JSON.stringify(this.state));
  }

  // ── Episode Update ───────────────────────────────────────────────

  /**
   * Update relationship state from a newly created episode.
   * Extracts relationship-relevant data via AI analysis + heuristics.
   */
  async updateFromEpisode(
    episode: Episode,
    labels?: { userName?: string; agentName?: string },
  ): Promise<void> {
    if (!this.initialized) return;

    // Basic stats
    this.state.totalSessions++;
    this.state.totalDurationMinutes += Math.round(episode.durationSeconds / 60);
    if (!this.state.firstInteraction) {
      this.state.firstInteraction = episode.startTime;
    }
    this.state.lastInteraction = episode.endTime;

    // Streak tracking
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    if (this.state.lastStreakDate === today) {
      // Already counted today
    } else if (this.state.lastStreakDate === yesterday) {
      this.state.currentStreak++;
      this.state.lastStreakDate = today;
    } else if (this.state.lastStreakDate !== today) {
      this.state.currentStreak = 1;
      this.state.lastStreakDate = today;
    }

    if (this.state.currentStreak > this.state.longestStreak) {
      this.state.longestStreak = this.state.currentStreak;
    }

    // Peak hours
    const hour = new Date(episode.startTime).getHours();
    this.state.peakHours.push(hour);
    if (this.state.peakHours.length > 100) {
      this.state.peakHours = this.state.peakHours.slice(-100);
    }

    // Topic tracking
    for (const topic of episode.topics) {
      const existing = this.state.favouriteTopics.find(
        (t) => t.topic.toLowerCase() === topic.toLowerCase()
      );
      if (existing) {
        existing.count++;
      } else {
        this.state.favouriteTopics.push({ topic, count: 1 });
      }
    }
    this.state.favouriteTopics.sort((a, b) => b.count - a.count);
    this.state.favouriteTopics = this.state.favouriteTopics.slice(0, 20);

    // Trust level — logarithmic growth with streak bonus
    this.state.trustLevel = Math.min(
      1.0,
      0.3 + Math.log10(this.state.totalSessions + 1) * 0.2 +
      Math.min(this.state.currentStreak * 0.02, 0.2)
    );

    // AI analysis for relationship-specific insights
    await this.analyseEpisodeForRelationship(episode, labels);

    await this.save();
  }

  // ── Context Generation ───────────────────────────────────────────

  /**
   * Build a context string for LLM system prompt injection.
   * @param userName — The user's name for personalized descriptions
   */
  getContextString(userName?: string): string {
    if (this.state.totalSessions === 0) return '';
    const uName = userName || 'The user';

    const parts: string[] = ['## Relationship Context'];

    // Duration and frequency
    const daysSinceFirst = this.state.firstInteraction
      ? Math.max(1, Math.floor((Date.now() - this.state.firstInteraction) / 86400000))
      : 1;
    parts.push(
      `- ${this.state.totalSessions} conversations over ${daysSinceFirst} days ` +
      `(${this.state.totalDurationMinutes} total minutes)`
    );

    // Streak
    if (this.state.currentStreak > 1) {
      parts.push(`- Current streak: ${this.state.currentStreak} consecutive days`);
    }

    // Trust level description
    if (this.state.trustLevel > 0.8) {
      parts.push(`- Deep trust established — ${uName} treats you as a genuine collaborator`);
    } else if (this.state.trustLevel > 0.6) {
      parts.push(`- Strong working relationship — ${uName} relies on you regularly`);
    } else if (this.state.trustLevel > 0.4) {
      parts.push(`- Growing familiarity — ${uName} is becoming comfortable with your style`);
    }

    // Favourite topics
    const topTopics = this.state.favouriteTopics.slice(0, 5);
    if (topTopics.length > 0) {
      parts.push(`- Most discussed topics: ${topTopics.map((t) => t.topic).join(', ')}`);
    }

    // Inside jokes
    if (this.state.insideJokes.length > 0) {
      const recent = this.state.insideJokes.slice(-3);
      parts.push(`- Inside jokes/references you share: ${recent.join('; ')}`);
    }

    // Shared references
    const topRefs = this.state.sharedReferences
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    if (topRefs.length > 0) {
      parts.push(
        `- Recurring references: ${topRefs.map((r) => `${r.reference} (${r.context})`).join('; ')}`
      );
    }

    // Communication preferences
    const highConfPrefs = this.state.communicationPreferences
      .filter((p) => p.confidence > 0.6)
      .slice(0, 3);
    if (highConfPrefs.length > 0) {
      parts.push(
        `- Communication notes: ${highConfPrefs.map((p) => `${p.trait}: ${p.value}`).join('; ')}`
      );
    }

    // Peak hours
    if (this.state.peakHours.length >= 10) {
      const hourCounts: Record<number, number> = {};
      for (const h of this.state.peakHours) {
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      }
      const peakHour = Object.entries(hourCounts).sort(([, a], [, b]) => b - a)[0];
      if (peakHour) {
        const h = parseInt(peakHour[0]);
        const period = h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
        parts.push(`- ${uName} usually chats in the ${period} (peak: ${h}:00)`);
      }
    }

    return parts.join('\n');
  }

  // ── AI Analysis ──────────────────────────────────────────────────

  private async analyseEpisodeForRelationship(
    episode: Episode,
    labels?: { userName?: string; agentName?: string },
  ): Promise<void> {
    if (!this.analyzer) return;
    if (episode.durationSeconds < 120 && episode.turnCount < 6) return;

    try {
      const userName = labels?.userName || 'User';
      const agentName = labels?.agentName || 'Agent';
      const transcript = episode.transcript
        ? episode.transcript
            .map((t) => `${t.role === 'user' ? userName : agentName}: ${t.text}`)
            .join('\n')
            .slice(-4000)
        : episode.summary;

      const analysis = await this.analyzer(transcript, this.state.insideJokes.slice(-5));

      // Merge inside jokes
      if (Array.isArray(analysis.newInsideJokes)) {
        for (const joke of analysis.newInsideJokes) {
          if (joke && !this.state.insideJokes.includes(joke)) {
            this.state.insideJokes.push(joke);
          }
        }
        if (this.state.insideJokes.length > 20) {
          this.state.insideJokes = this.state.insideJokes.slice(-20);
        }
      }

      // Merge shared references
      if (Array.isArray(analysis.sharedReferences)) {
        for (const ref of analysis.sharedReferences) {
          if (!ref) continue;
          const existing = this.state.sharedReferences.find(
            (r) => r.reference.toLowerCase() === ref.toLowerCase()
          );
          if (existing) {
            existing.count++;
            existing.lastMentioned = Date.now();
          } else {
            this.state.sharedReferences.push({
              reference: ref,
              context: episode.summary.slice(0, 80),
              firstMentioned: Date.now(),
              lastMentioned: Date.now(),
              count: 1,
            });
          }
        }
        if (this.state.sharedReferences.length > 30) {
          this.state.sharedReferences.sort((a, b) => b.count - a.count);
          this.state.sharedReferences = this.state.sharedReferences.slice(0, 30);
        }
      }

      // Merge communication preferences
      if (Array.isArray(analysis.communicationNotes)) {
        for (const note of analysis.communicationNotes) {
          if (!note?.trait || !note?.value) continue;
          const existing = this.state.communicationPreferences.find(
            (p) => p.trait.toLowerCase() === note.trait.toLowerCase()
          );
          if (existing) {
            existing.value = note.value;
            existing.confidence = Math.min(1, existing.confidence + 0.1);
            existing.observedAt = Date.now();
          } else {
            this.state.communicationPreferences.push({
              trait: note.trait,
              value: note.value,
              confidence: 0.5,
              observedAt: Date.now(),
            });
          }
        }
        if (this.state.communicationPreferences.length > 15) {
          this.state.communicationPreferences.sort((a, b) => b.confidence - a.confidence);
          this.state.communicationPreferences = this.state.communicationPreferences.slice(0, 15);
        }
      }

      // Mood tracking
      if (analysis.moodSummary) {
        this.state.averageMood = analysis.moodSummary;
      }
    } catch (err) {
      console.warn('[RelationshipMemory] Analysis failed:', err);
    }
  }

  // ── Persistence ──────────────────────────────────────────────────

  async flush(): Promise<void> {
    await this.save();
  }

  private async save(): Promise<void> {
    if (!this.storageDir) return;
    const filePath = path.join(this.storageDir, 'relationship.json');
    await fs.writeFile(filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  private async load(): Promise<void> {
    const filePath = path.join(this.storageDir, 'relationship.json');
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const loaded = JSON.parse(data);
      this.state = { ...DEFAULTS, ...loaded };
    } catch {
      // File doesn't exist yet
    }
  }
}
