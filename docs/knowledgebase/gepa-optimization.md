# GEPA Prompt Optimization: Analytical Deep Dive

> Automatically evolve and improve insight-generation prompts using Multi-Objective Genetic-Pareto Optimization.

---

## Overview

**GEPA (Genetic-Pareto)** is the automated prompt engineering engine of Code Insights. It eliminates the need for manual prompt tweaking by treating prompt optimization as a machine learning training problem.

Instead of a developer guessing which wording "might" produce better insights, GEPA runs a systematic evolutionary loop: it tries hundreds of prompt variants against real session data, scores them across four competing objectives, and selects the mathematical "best" variant on the Pareto frontier.

---

## The Evolutionary Loop

The system operates on a **Student-Teacher architecture**:

1.  **Preparation**: The system loads real session transcripts from your local database as training and validation examples.
2.  **Inference (Student)**: A faster, cost-effective model (the "Student") generates insights using a mutated prompt variant.
3.  **Evaluation (Teacher)**: A high-reasoning model (the "Teacher") evaluates the student's output.
4.  **Scoring (Multi-Objective)**: The teacher's feedback is converted into quantitative scores for:
    -   **Coverage**: Did it capture all the key themes of the session?
    -   **Precision**: Are the insights dense and free of "hallucinated" or trivial filler?
    -   **Actionability**: Does it provide concrete, prescriptive guidance?
    -   **Brevity**: Is it concise enough to keep costs low and readability high?
5.  **Pareto Selection**: The loop tracks "non-dominated" solutions—prompts that excel in one objective without being significantly worse in others.

### Phase 1b Architecture: Identity & Targets

In GEPA Phase 1b, the prompt optimization architecture has been enhanced to support strict tuning boundaries and precise model provenance.

#### Student Identity Engine

Every prompt optimization is deeply coupled to the specific model that generated it. The Student Identity Engine (`cli/src/optimization/identity.ts`) strictly enforces this linkage using a canonical format:

`runner|model|variant`

Examples:
- `claude-code-native|claude-sonnet-4-6|high`
- `opencode|anthropic/claude-3-7-sonnet|high`
- `provider:anthropic|claude-3-5-sonnet-latest|`

**Strict rules:**
- The pipe `|` is the absolute delimiter.
- Identity components cannot contain `|`.
- The `identityForCall()` function evaluates the actual runner result (not just the requested model) to accurately capture provenance.

#### Target Registry

The Target Registry (`cli/src/optimization/targets.ts`) defines exactly what GEPA is allowed to tune (mutable) versus what must remain constant (frozen):

- **`session-analysis` (Enabled):**
  - **Mutable:** `frictionGuidance` and `patternGuidance`.
  - **Frozen:** JSON schema, canonical categories, output format, system prompt.
- **`prompt-quality` (Disabled - Ready for Phase 2):**
  - **Mutable:** `promptQualityGuidance`.

By freezing the JSON schema and categories, GEPA can optimize the linguistic nuance of the prompt without breaking the downstream data pipeline.

#### Prompt Resolution & Fallback Guards

When a background job needs to analyze a session, the system uses `resolveAnalysisPrompt(target, identityKey)` (`cli/src/optimization/resolve-prompt.ts`) to fetch the tuned prompt variant that precisely matches the current target and the available student model.

**The `IdentityMismatchError` Fallback Guard:**
If a tuned prompt (`versionId !== null`) is dispatched, but an un-tuned fallback runner answers (e.g., due to API rate limits on the primary model), the system throws an `IdentityMismatchError` in the runner pipeline. The queue worker catches this error and leaves the task to be retried when the designated student model becomes available. This critical guard ensures that prompts optimized for a specific model are never evaluated by a different, potentially incompatible model.

#### Schema V18 Provenance

To track the effectiveness of optimizations in production, Schema V18 introduced two new columns to the `insights` and `session_facets` tables:
- `student_identity`: The `runner|model|variant` that produced the data.
- `prompt_version_id`: The specific GEPA artifact version used.

---

### System Architecture

[View Live Architecture Diagram (Interactive HTML)](../assets/gepa-optimization-diagram.html)

```mermaid
graph TD
    subgraph "Target Registry"
        TR[Targets] --> |Mutable Guidance| OP
        TR --> |Frozen Schema/Format| OP
    end

    subgraph "Optimization Loop (AxGEPA)"
        T[Teacher AI - Evaluates] --> |Feedback| S[Student AI - Generates]
        S --> |Mutated Prompt| M[Multi-Objective Metric]
        M --> |Scores| PF[Pareto Frontier]
        PF --> |New Candidates| T
    end

    DB[(Sessions DB)] --> |Training Data| S
    OP[Optimization Pipeline] --> S
    PF --> |Winning Variant| AR[(Local Registry)]
    
    subgraph "Production Resolution & Guard"
        SI[Student Identity Engine] --> |identityForCall| PR[Prompt Resolution]
        AR --> PR
        PR --> |Tuned Prompt| AW[Analysis Worker]
        AW --> |IdentityMismatchError?| Q[Queue Worker Retry]
        AW --> |Success| DB18[(Schema V18 DB)]
    end
    
    style T fill:#4c1d95,stroke:#a78bfa,color:#fff
    style S fill:#083344,stroke:#22d3ee,color:#fff
    style M fill:#064e3b,stroke:#34d399,color:#fff
    style PF fill:#78230f,stroke:#fbbf24,color:#fff
    style SI fill:#1e40af,stroke:#3b82f6,color:#fff
    style TR fill:#166534,stroke:#22c55e,color:#fff
```

---

## Measuring Quality: The Objectives

The power of GEPA lies in its ability to balance competing goals. In prompt engineering, there is often a trade-off between **Coverage** (more info) and **Brevity** (less tokens). GEPA finds the "sweet spot."

| Objective | Logic | Scoring Constraint |
| :--- | :--- | :--- |
| **Coverage** | Topic overlap between transcript and output. | 0 = Missed everything; 100 = 100% overlap. |
| **Precision** | Ratio of specific references (file paths, errors) to filler. | Penalizes generic "fluff" or neutral summaries. |
| **Actionability** | Presence of "Action Verbs" and prescriptive guidance. | 0 = Observations; 100 = Specific "Should/Avoid" advice. |
| **Brevity** | Token count normalized against a desired target. | Penalizes "chatty" responses that inflate LLM costs. |

---

## Artifacts and Persistence

Code Insights stores all optimization results locally in `~/.code-insights/optimizations/`.

-   **`manifest.json`**: The central registry tracking all versions and the current active ID.
-   **`artifact.json`**: The serialized "AxProgram"—this is the "binary" of your prompt. It contains the exact instructions the AI uses.
-   **`scores.json`**: The proof of performance, showing exactly how this version performed on the Pareto frontier compared to its predecessors.

---

## CLI Integration

You can manage the full lifecycle of your prompts from the terminal:

```bash
# Start an optimization run (recommends gpt-4o-mini student + claude-3.5-sonnet teacher)
code-insights optimize run

# Compare two versions to see the "delta" in actionability and precision
code-insights optimize compare v1 v7

# List all local prompt versions
code-insights optimize list
```

## Why it Matters

Manual prompt engineering is "vibe-based." You change a word and *feel* like it might be better. GEPA is **evidence-based**. It ensures that as you analyze thousands of coding sessions, the insights you receive are becoming more actionable, more precise, and more cost-efficient over time.
