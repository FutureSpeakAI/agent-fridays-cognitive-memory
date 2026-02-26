/**
 * cognitive-memory — AI agent memory system with three-tier architecture,
 * sleep-like consolidation, episodic recording, and relationship tracking.
 *
 * Built by FutureSpeak.AI — extracted from Agent Friday, the AGI OS.
 * https://github.com/FutureSpeakAI/Agent-Friday
 */

// Core memory manager
export { MemoryManager } from './memory-manager';
export type {
  ShortTermEntry,
  MediumTermEntry,
  LongTermEntry,
  MemoryStore,
  ExtractionResult,
  ExtractorFn,
  MemoryHooks,
} from './memory-manager';

// Sleep-like consolidation
export { MemoryConsolidation, computePromotionScore } from './memory-consolidation';
export type {
  ConsolidationConfig,
  MergeFn,
  InsightFn,
  SimilaritySearchFn,
} from './memory-consolidation';

// Episodic memory
export { EpisodicMemoryStore } from './episodic-memory';
export type {
  Episode,
  EpisodeAnalysis,
  EpisodeAnalyzerFn,
  EpisodicHooks,
} from './episodic-memory';

// Relationship tracking
export { RelationshipMemory } from './relationship-memory';
export type {
  SharedReference,
  CommunicationPreference,
  RelationshipState,
  RelationshipAnalysis,
  RelationshipAnalyzerFn,
} from './relationship-memory';
