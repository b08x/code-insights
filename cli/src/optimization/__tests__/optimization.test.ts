// Tests for GEPA optimization module.
// Covers: metric function, prompt versioning, flow creation, and runner config.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

// ─── Metric function tests ───────────────────────────────────────────────────

import {
  multiObjectiveMetric,
  scalarizeScores,
  type MetricInput,
} from '../../optimization/metric.js';

describe('multiObjectiveMetric', () => {
  it('returns scores for all four objectives', () => {
    const input: MetricInput = {
      prediction: {
        insights: [
          {
            category: 'architecture-decision',
            description: 'Use a singleton pattern for the database connection',
            confidence: 85,
            evidence: ['User#1: We need one DB connection', 'Assistant#2: Use a singleton'],
          },
        ],
        quality: 0.8,
      },
      example: {
        sessionData: 'User: We need one DB connection\nAssistant: Use a singleton pattern',
        sessionTopics: ['database', 'singleton'],
      },
    };

    const scores = multiObjectiveMetric(input);

    expect(scores).toHaveProperty('coverage');
    expect(scores).toHaveProperty('precision');
    expect(scores).toHaveProperty('actionability');
    expect(scores).toHaveProperty('brevity');

    // All scores should be in [0, 1]
    for (const [key, value] of Object.entries(scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('returns zero scores for empty insights', () => {
    const input: MetricInput = {
      prediction: { insights: [], quality: 0 },
      example: { sessionData: 'some session data' },
    };

    const scores = multiObjectiveMetric(input);

    expect(scores.coverage).toBe(0);
    expect(scores.precision).toBe(0);
    expect(scores.actionability).toBe(0);
    expect(scores.brevity).toBe(0);
  });

  it('does not crash when insights is the whole JSON envelope object', () => {
    // Regression: AxFlow's parser can return the entire parsed JSON
    // object (containing both `insights` and `quality`) under
    // `prediction.insights` when the LLM returns one combined object.
    // The metric must unwrap it to the inner array.
    const input: MetricInput = {
      prediction: {
        insights: {
          insights: [
            {
              category: 'debugging-pattern',
              description: 'Check null guards in auth.ts before accessing session.userId',
              confidence: 85,
              evidence: ['User#3: Getting null pointer in auth.ts'],
            },
          ],
          quality: 0.85,
        },
        quality: 0.5,
      },
      example: {
        sessionData: 'some session data about null guards',
        sessionTopics: ['null', 'auth'],
      },
    };

    const scores = multiObjectiveMetric(input);

    // Should not throw, all scores in [0,1]
    for (const [key, value] of Object.entries(scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // At least one objective should score > 0 since we have a real insight
    expect(scores.precision).toBeGreaterThan(0);
  });

  it('does not crash when insights is wrapped with Title Case key "Insights"', () => {
    // Regression: Ax prompt template renders field titles in Title Case
    // ("Insights" not "insights"). The LLM faithfully follows this,
    // returning {"Insights": [...]} instead of {"insights": [...]}.
    // normalizeInsights must handle both — this is the enum-drift defense.
    const input: MetricInput = {
      prediction: {
        insights: {
          Insights: [
            {
              category: 'architecture-decision',
              description: 'Chose monorepo structure for shared types across packages',
              confidence: 85,
              evidence: ["User#3: Let's use a monorepo"],
            },
          ],
        },
        quality: 0.85,
      },
      example: {
        sessionData: "User#3: Let's use a monorepo. Assistant#4: Good idea.",
        sessionTopics: ['monorepo', 'architecture'],
      },
    };

    const scores = multiObjectiveMetric(input);

    // Should not throw, all scores in [0,1]
    for (const [key, value] of Object.entries(scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // Coverage should be > 0 because the insight references session topics
    expect(scores.coverage).toBeGreaterThan(0);
    expect(scores.precision).toBeGreaterThan(0);
  });

  it('does not crash when insights is undefined or null', () => {
    const inputs: MetricInput[] = [
      { prediction: { insights: undefined as any, quality: 0 }, example: { sessionData: 'x' } },
      { prediction: { insights: null as any, quality: 0 }, example: { sessionData: 'x' } },
      { prediction: { insights: 'a string' as any, quality: 0 }, example: { sessionData: 'x' } },
      { prediction: { insights: 42 as any, quality: 0 }, example: { sessionData: 'x' } },
    ];

    for (const input of inputs) {
      const scores = multiObjectiveMetric(input);
      expect(scores.coverage).toBe(0);
      expect(scores.precision).toBe(0);
      expect(scores.actionability).toBe(0);
      expect(scores.brevity).toBe(0);
    }
  });

  it('scores high precision for specific, evidence-backed insights', () => {
    const input: MetricInput = {
      prediction: {
        insights: [
          {
            category: 'debugging-pattern',
            description: 'The error in auth.ts:42 was caused by missing null check',
            confidence: 90,
            evidence: ['User#3: Getting null pointer in auth.ts'],
          },
          {
            category: 'refactoring',
            description: 'Extract the validation logic into a separate utility function',
            confidence: 80,
            evidence: ['Assistant#5: Consider extracting validation'],
          },
        ],
        quality: 0.9,
      },
      example: {
        sessionData: 'Long session about debugging auth issues and refactoring validation',
        sessionTopics: ['debugging', 'refactoring', 'auth'],
      },
    };

    const scores = multiObjectiveMetric(input);

    // Both insights have evidence and high confidence → high precision
    expect(scores.precision).toBeGreaterThan(0.5);
  });

  it('scores low precision for filler insights', () => {
    const input: MetricInput = {
      prediction: {
        insights: [
          {
            category: 'general',
            description: 'Good use of TypeScript throughout the session',
            confidence: 50,
            evidence: [],
          },
          {
            category: 'general',
            description: 'The session went well with no issues',
            confidence: 30,
            evidence: [],
          },
        ],
        quality: 0.3,
      },
      example: {
        sessionData: 'A session about TypeScript development',
        sessionTopics: ['typescript'],
      },
    };

    const scores = multiObjectiveMetric(input);

    // Filler insights with low confidence → low precision
    expect(scores.precision).toBeLessThan(0.5);
  });

  it('scores high actionability for imperative insights', () => {
    const input: MetricInput = {
      prediction: {
        insights: [
          {
            category: 'best-practice',
            description: 'Use a factory pattern for creating service instances',
            confidence: 85,
            evidence: ['User#1: How should I create services?'],
          },
          {
            category: 'refactoring',
            description: 'Avoid using any types in the public API surface',
            confidence: 90,
            evidence: ['Assistant#2: Prefer explicit types over any'],
          },
        ],
        quality: 0.85,
      },
      example: {
        sessionData: 'Discussion about service creation and type safety',
        sessionTopics: ['factory', 'type-safety'],
      },
    };

    const scores = multiObjectiveMetric(input);

    // Both insights start with action verbs → high actionability
    expect(scores.actionability).toBeGreaterThan(0.5);
  });

  it('scores high brevity for concise insights', () => {
    const input: MetricInput = {
      prediction: {
        insights: [
          {
            category: 'tip',
            description: 'Use const assertions for literal types',
            confidence: 90,
            evidence: ['User#1'],
          },
        ],
        quality: 0.8,
      },
      example: {
        sessionData: 'Short session',
        sessionTopics: ['typescript'],
      },
    };

    const scores = multiObjectiveMetric(input);

    // Very short insight → high brevity
    expect(scores.brevity).toBeGreaterThanOrEqual(0.8);
  });

  it('uses humanQuality for coverage when provided', () => {
    const input: MetricInput = {
      prediction: {
        insights: [{ category: 'test', description: 'Test insight', confidence: 80, evidence: [] }],
        quality: 0.5,
      },
      example: {
        sessionData: 'Session data',
        humanQuality: 0.95,
      },
    };

    const scores = multiObjectiveMetric(input);

    expect(scores.coverage).toBe(0.95);
  });

  it('clamps all scores to [0, 1]', () => {
    const input: MetricInput = {
      prediction: {
        insights: [
          {
            category: 'test',
            description: 'x'.repeat(10000), // Very long → should clamp brevity
            confidence: 100,
            evidence: ['User#1', 'User#2', 'User#3'],
          },
        ],
        quality: 0.5,
      },
      example: {
        sessionData: 'Short',
        humanQuality: 1.5, // > 1 → should clamp
      },
    };

    const scores = multiObjectiveMetric(input);

    for (const [key, value] of Object.entries(scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(scores.coverage).toBe(1); // clamped from 1.5
  });
});

describe('scalarizeScores', () => {
  it('returns weighted sum of scores', () => {
    const scores = { coverage: 0.8, precision: 0.6, actionability: 0.7, brevity: 0.9 };
    const weights = { coverage: 0.35, precision: 0.30, actionability: 0.20, brevity: 0.15 };

    const result = scalarizeScores(scores, weights);

    const expected = 0.35 * 0.8 + 0.30 * 0.6 + 0.20 * 0.7 + 0.15 * 0.9;
    expect(result).toBeCloseTo(expected, 5);
  });

  it('uses default weights when none provided', () => {
    const scores = { coverage: 1.0, precision: 1.0, actionability: 1.0, brevity: 1.0 };

    const result = scalarizeScores(scores);

    expect(result).toBeCloseTo(0.8, 1);
  });

  it('returns 0 for empty scores', () => {
    const result = scalarizeScores({}, {});

    expect(result).toBe(0);
  });

  it('handles partial objectives', () => {
    const scores = { coverage: 0.5 };
    const weights = { coverage: 1.0, precision: 0.0 };

    const result = scalarizeScores(scores, weights);

    expect(result).toBe(0.5);
  });
});

// ─── Flow creation tests ─────────────────────────────────────────────────────

import { createInsightProgram, INSIGHT_INSTRUCTION, INSIGHT_OUTPUT_FORMAT, type InsightOutput } from '../../optimization/flow.js';

describe('createInsightProgram', () => {
  it('creates a program without errors', () => {
    const program = createInsightProgram();
    expect(program).toBeDefined();
  });

  it('returns an object with the expected shape', () => {
    const program = createInsightProgram();
    // AxGen instances have a forward method
    expect(typeof program.forward).toBe('function');
  });

  it('includes the output format in its description (regression: parser-contract)', () => {
    // Regression: the Ax signature only carries a single `description`
    // field. The output format MUST be concatenated into that field or
    // the LLM has no idea what shape to emit, and AxFlow's vs() parser
    // extracts nothing — every metric then scores 0.
    const program = createInsightProgram() as unknown as Record<string, unknown>;

    // Drill into the program signature to find the description string.
    // Ax stores it under program.signature.description.
    const signature = (program as { signature?: { description?: string } }).signature;
    const description = signature?.description ?? '';

    // The combined instruction must include the output format so the
    // LLM knows to emit "Insights: ..." and "Quality: ..." blocks.
    expect(description).toContain(INSIGHT_INSTRUCTION);
    expect(description).toContain('Insights:');
    expect(description).toContain('Quality:');
  });
});

describe('INSIGHT_INSTRUCTION', () => {
  it('is a non-empty string', () => {
    expect(typeof INSIGHT_INSTRUCTION).toBe('string');
    expect(INSIGHT_INSTRUCTION.length).toBeGreaterThan(0);
  });

  it('contains key instruction elements', () => {
    expect(INSIGHT_INSTRUCTION).toContain('insights');
    expect(INSIGHT_INSTRUCTION).toContain('category');
    expect(INSIGHT_INSTRUCTION).toContain('confidence');
    expect(INSIGHT_INSTRUCTION).toContain('evidence');
  });
});

describe('INSIGHT_OUTPUT_FORMAT', () => {
  it('is a non-empty string', () => {
    expect(typeof INSIGHT_OUTPUT_FORMAT).toBe('string');
    expect(INSIGHT_OUTPUT_FORMAT.length).toBeGreaterThan(0);
  });

  it('contains field-prefixed blocks that match AxFlow parser', () => {
    // Regression: AxFlow's vs() parser scans for `Insights:` and `Quality:`
    // prefixes in the LLM response. The format MUST contain these
    // field-title prefixes or the parser will fail to extract the fields.
    expect(INSIGHT_OUTPUT_FORMAT).toContain('Insights:');
    expect(INSIGHT_OUTPUT_FORMAT).toContain('Quality:');
    expect(INSIGHT_OUTPUT_FORMAT).toContain('insights');
  });

  it('does NOT use a single <json> envelope (AxFlow 22.0.2 does not understand it)', () => {
    expect(INSIGHT_OUTPUT_FORMAT).not.toContain('<json>');
    expect(INSIGHT_OUTPUT_FORMAT).not.toContain('</json>');
  });
});

describe('InsightOutput type', () => {
  it('accepts valid insight output', () => {
    const output: InsightOutput = {
      insights: [
        {
          category: 'test',
          description: 'A test insight',
          confidence: 85,
          evidence: ['User#1: test'],
        },
      ],
      quality: 0.85,
    };

    expect(output.insights).toHaveLength(1);
    expect(output.quality).toBe(0.85);
  });

  it('accepts empty insights array', () => {
    const output: InsightOutput = {
      insights: [],
      quality: 0,
    };

    expect(output.insights).toHaveLength(0);
  });
});

// ─── Prompt versioning tests ─────────────────────────────────────────────────

import {
  ensureOptimizationDir,
  loadManifest,
  saveManifest,
  registerVersion,
  activateVersion,
  getActiveVersion,
  deleteVersion,
  saveArtifact,
  loadArtifact,
  saveScores,
  loadScores,
  saveMetadata,
  loadMetadata,
  compareVersions,
  listVersions,
  hasOptimizedPrompt,
  _setOptimizationDir,
  type OptimizationManifest,
  type OptimizationVersion,
} from '../../optimization/prompts.js';

// Use an isolated temp directory for each test run to avoid races
// with other test suites (e.g. runner.test.ts) that also hit disk.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'ci-opt-test-'));
_setOptimizationDir(TEST_DIR);

describe('prompt versioning', () => {
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('ensureOptimizationDir', () => {
    it('creates the optimization directory', () => {
      ensureOptimizationDir();
      expect(fs.existsSync(TEST_DIR)).toBe(true);
    });

    it('is idempotent', () => {
      ensureOptimizationDir();
      ensureOptimizationDir();
      expect(fs.existsSync(TEST_DIR)).toBe(true);
    });
  });

  describe('loadManifest / saveManifest', () => {
    it('returns empty manifest when none exists', () => {
      const manifest = loadManifest();
      expect(manifest.versions).toHaveLength(0);
      expect(manifest.currentVersion).toBeNull();
    });

    it('saves and loads a manifest', () => {
      const manifest: OptimizationManifest = {
        versions: [
          {
            id: 'v1',
            createdAt: new Date().toISOString(),
            optimizerType: 'GEPA',
            numTrials: 25,
            objectives: ['coverage', 'precision'],
            bestScore: 0.85,
            converged: true,
            totalRounds: 10,
            optimizationTimeMs: 5000,
            paretoFrontSize: 5,
            active: true,
          },
        ],
        currentVersion: 'v1',
        updatedAt: new Date().toISOString(),
      };

      saveManifest(manifest);
      const loaded = loadManifest();

      expect(loaded.versions).toHaveLength(1);
      expect(loaded.versions[0].id).toBe('v1');
      expect(loaded.currentVersion).toBe('v1');
    });
  });

  describe('registerVersion', () => {
    it('registers a new version with auto-generated ID', () => {
      const version = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage', 'precision', 'actionability', 'brevity'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      });

      expect(version.id).toBe('v1');
      expect(version.active).toBe(false);
    });

    it('auto-increments version IDs', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.8,
        converged: false,
        totalRounds: 5,
        optimizationTimeMs: 3000,
        paretoFrontSize: 3,
      });

      const v2 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 30,
        objectives: ['coverage'],
        bestScore: 0.9,
        converged: true,
        totalRounds: 12,
        optimizationTimeMs: 7000,
        paretoFrontSize: 7,
      });

      expect(v1.id).toBe('v1');
      expect(v2.id).toBe('v2');
    });

    it('activates version when activate=true', () => {
      const version = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      }, true);

      expect(version.active).toBe(true);
      expect(getActiveVersion()?.id).toBe(version.id);
    });
  });

  describe('activateVersion', () => {
    it('activates an existing version', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.8,
        converged: false,
        totalRounds: 5,
        optimizationTimeMs: 3000,
        paretoFrontSize: 3,
      });

      const result = activateVersion(v1.id);
      expect(result).toBe(true);
      expect(getActiveVersion()?.id).toBe(v1.id);
    });

    it('returns false for non-existent version', () => {
      const result = activateVersion('v999');
      expect(result).toBe(false);
    });

    it('deactivates previous version when activating new one', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.8,
        converged: false,
        totalRounds: 5,
        optimizationTimeMs: 3000,
        paretoFrontSize: 3,
      }, true);

      const v2 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 30,
        objectives: ['coverage'],
        bestScore: 0.9,
        converged: true,
        totalRounds: 12,
        optimizationTimeMs: 7000,
        paretoFrontSize: 7,
      }, true);

      expect(getActiveVersion()?.id).toBe(v2.id);

      const manifest = loadManifest();
      const v1Entry = manifest.versions.find(v => v.id === v1.id);
      expect(v1Entry?.active).toBe(false);
    });
  });

  describe('getActiveVersion', () => {
    it('returns null when no version is active', () => {
      expect(getActiveVersion()).toBeNull();
    });

    it('returns the active version', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      }, true);

      const active = getActiveVersion();
      expect(active?.id).toBe(v1.id);
    });
  });

  describe('deleteVersion', () => {
    it('deletes an existing version', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      });

      const result = deleteVersion(v1.id);
      expect(result).toBe(true);

      const manifest = loadManifest();
      expect(manifest.versions).toHaveLength(0);
    });

    it('returns false for non-existent version', () => {
      const result = deleteVersion('v999');
      expect(result).toBe(false);
    });

    it('clears currentVersion if deleted version was active', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      }, true);

      deleteVersion(v1.id);

      const manifest = loadManifest();
      expect(manifest.currentVersion).toBeNull();
    });
  });

  describe('artifact operations', () => {
    it('saves and loads artifacts', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      });

      const artifact = { instruction: 'optimized prompt', outputFormat: 'json' };
      saveArtifact(v1.id, artifact);
      const loaded = loadArtifact(v1.id);

      expect(loaded).toEqual(artifact);
    });

    it('returns null for missing artifacts', () => {
      const loaded = loadArtifact('v999');
      expect(loaded).toBeNull();
    });

    it('saves and loads scores', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      });

      const scores = {
        paretoFront: [
          { scores: { coverage: 0.8, precision: 0.7 }, configuration: {}, dominatedSolutions: 0 },
        ],
        selectedPoint: { scores: { coverage: 0.8, precision: 0.7 }, configuration: {}, dominatedSolutions: 0 },
        selectionMethod: 'weighted-sum',
      };
      saveScores(v1.id, scores);
      const loaded = loadScores(v1.id);

      expect(loaded?.paretoFront).toHaveLength(1);
      expect(loaded?.selectionMethod).toBe('weighted-sum');
    });

    it('saves and loads metadata', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      });

      const metadata = {
        versionId: v1.id,
        createdAt: new Date().toISOString(),
        studentModel: 'openai/gpt-4o-mini',
        teacherModel: 'anthropic/claude-sonnet-4',
        trainingExampleCount: 50,
        validationExampleCount: 10,
      };
      saveMetadata(v1.id, metadata);
      const loaded = loadMetadata(v1.id);

      expect(loaded?.studentModel).toBe('openai/gpt-4o-mini');
      expect(loaded?.trainingExampleCount).toBe(50);
    });
  });

  describe('compareVersions', () => {
    it('compares two versions', () => {
      const v1 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.8,
        converged: false,
        totalRounds: 5,
        optimizationTimeMs: 3000,
        paretoFrontSize: 3,
      });

      const v2 = registerVersion({
        optimizerType: 'GEPA',
        numTrials: 30,
        objectives: ['coverage'],
        bestScore: 0.9,
        converged: true,
        totalRounds: 12,
        optimizationTimeMs: 7000,
        paretoFrontSize: 7,
      });

      const comparison = compareVersions(v1.id, v2.id);

      expect(comparison.versionA?.id).toBe(v1.id);
      expect(comparison.versionB?.id).toBe(v2.id);
    });

    it('returns null for non-existent versions', () => {
      const comparison = compareVersions('v999', 'v1000');

      expect(comparison.versionA).toBeNull();
      expect(comparison.versionB).toBeNull();
    });
  });

  describe('listVersions', () => {
    it('returns empty list when no versions exist', () => {
      expect(listVersions()).toHaveLength(0);
    });

    it('returns all registered versions', () => {
      for (let i = 0; i < 3; i++) {
        registerVersion({
          optimizerType: 'GEPA',
          numTrials: 25,
          objectives: ['coverage'],
          bestScore: 0.8 + i * 0.05,
          converged: false,
          totalRounds: 5,
          optimizationTimeMs: 3000,
          paretoFrontSize: 3,
        });
      }

      expect(listVersions()).toHaveLength(3);
    });
  });

  describe('hasOptimizedPrompt', () => {
    it('returns false when no versions exist', () => {
      expect(hasOptimizedPrompt()).toBe(false);
    });

    it('returns false when versions exist but none is active', () => {
      registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      });

      expect(hasOptimizedPrompt()).toBe(false);
    });

    it('returns true when an active version exists', () => {
      registerVersion({
        optimizerType: 'GEPA',
        numTrials: 25,
        objectives: ['coverage'],
        bestScore: 0.85,
        converged: true,
        totalRounds: 10,
        optimizationTimeMs: 5000,
        paretoFrontSize: 5,
      }, true);

      expect(hasOptimizedPrompt()).toBe(true);
    });
  });
});

// ─── Runner config tests ─────────────────────────────────────────────────────

import { createGEPARunner, type GEPARunnerConfig } from '../../optimization/runner.js';

describe('createGEPARunner', () => {
  it('creates a runner with default config', () => {
    const runner = createGEPARunner({
      studentProvider: 'openai',
      studentApiKey: 'test-key',
      studentModel: 'gpt-4o-mini',
    });

    expect(runner).toBeDefined();
  });

  it('creates a runner with custom config', () => {
    const runner = createGEPARunner({
      studentProvider: 'anthropic',
      studentApiKey: 'test-key',
      studentModel: 'claude-sonnet-4-20250514',
      teacherProvider: 'openai',
      teacherModel: 'gpt-4o',
      numTrials: 30,
      seed: 123,
      verbose: true,
      maxMetricCalls: 100,
      earlyStoppingTrials: 5,
      minibatchSize: 8,
    });

    expect(runner).toBeDefined();
  });
});
