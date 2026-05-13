import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { predictForPart, type PredictInput, type Prediction } from "@/lib/predict";

// =============================================================================
// TypeScript scorer for scripts/train_failure_model.py
//
// Loads models/failure_predictor.json (portable dump emitted by the Python
// trainer) and scores predictions in-process. Falls back to the heuristic
// in lib/predict.ts when no model is present so the dashboard never breaks.
//
// JSON contract (mirrors _dump_regressor / _dump_classifier in the Python):
//
//   {
//     feature_names: string[],
//     trained_at: string,
//     regressor: {
//       type: 'gbr',
//       scaler: { mean: number[], scale: number[] },
//       init_prediction: number,
//       learning_rate: number,
//       n_estimators: number,
//       stages: TreeDump[],
//     } | null,
//     classifier: {
//       type: 'gbc',
//       scaler: { mean: number[], scale: number[] },
//       classes: string[],
//       learning_rate: number,
//       stages_per_class: TreeDump[][],   // [n_estimators][n_classes]
//     } | null,
//   }
//
// where TreeDump = {
//   feature: number[], threshold: number[],
//   children_left: number[], children_right: number[],
//   value: number[][],   // leaf prediction(s)
// }
// =============================================================================

type TreeDump = {
  feature: number[];
  threshold: number[];
  children_left: number[];
  children_right: number[];
  value: number[][];
};

type ScalerDump = { mean: number[]; scale: number[] };

type RegressorDump = {
  type: "gbr";
  scaler: ScalerDump;
  init_prediction: number;
  learning_rate: number;
  n_estimators: number;
  stages: TreeDump[];
};

type ClassifierDump = {
  type: "gbc";
  scaler: ScalerDump;
  classes: string[];
  learning_rate: number;
  stages_per_class: TreeDump[][];
};

type ModelBundle = {
  feature_names: string[];
  trained_at: string;
  regressor: RegressorDump | null;
  classifier: ClassifierDump | null;
};

const MODEL_PATH = path.join(process.cwd(), "models", "failure_predictor.json");

let _cached: { mtime: number; bundle: ModelBundle | null } | null = null;

async function loadModel(): Promise<ModelBundle | null> {
  try {
    const stat = await fs.stat(MODEL_PATH);
    if (_cached && _cached.mtime === stat.mtimeMs) return _cached.bundle;
    const raw = await fs.readFile(MODEL_PATH, "utf-8");
    const bundle = JSON.parse(raw) as ModelBundle;
    _cached = { mtime: stat.mtimeMs, bundle };
    return bundle;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// --------------------------------------------------------------------------
// Tree + ensemble scoring
// --------------------------------------------------------------------------

function applyScaler(x: number[], scaler: ScalerDump): number[] {
  return x.map((v, i) => (v - scaler.mean[i]) / (scaler.scale[i] || 1));
}

function scoreTree(tree: TreeDump, x: number[]): number {
  let node = 0;
  while (tree.children_left[node] !== -1) {
    const feat = tree.feature[node];
    const thresh = tree.threshold[node];
    node = x[feat] <= thresh ? tree.children_left[node] : tree.children_right[node];
  }
  // Regressor leaves are 1x1 arrays; classifier leaves are 1xK.
  return tree.value[node][0];
}

function scoreRegressor(reg: RegressorDump, raw: number[]): number {
  const x = applyScaler(raw, reg.scaler);
  let acc = reg.init_prediction;
  for (const tree of reg.stages) {
    acc += reg.learning_rate * scoreTree(tree, x);
  }
  return acc;
}

// Returns softmax-normalised class probabilities aligned with classifier.classes.
function scoreClassifier(cls: ClassifierDump, raw: number[]): number[] {
  const x = applyScaler(raw, cls.scaler);
  const k = cls.classes.length;
  // Binary classification in sklearn GBDT uses a single tree per stage; for
  // multi-class it emits one tree per class per stage and uses softmax.
  if (k === 2) {
    let logit = 0;
    for (const stage of cls.stages_per_class) {
      logit += cls.learning_rate * scoreTree(stage[0], x);
    }
    const p1 = 1 / (1 + Math.exp(-logit));
    return [1 - p1, p1];
  }
  const logits = new Array(k).fill(0);
  for (const stage of cls.stages_per_class) {
    for (let i = 0; i < k; i++) {
      logits[i] += cls.learning_rate * scoreTree(stage[i], x);
    }
  }
  // Softmax with the standard max-subtract for numerical stability.
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((v) => v / sum);
}

// --------------------------------------------------------------------------
// Feature vector adapter — turns a PredictInput into the FEATURE_NAMES order
// the trainer expects. When the dashboard hasn't yet ingested a fresh trends
// window we approximate the moving-window features from the lifecycle
// rollups (sufficient for the next-step prediction, not for backfilling).
// --------------------------------------------------------------------------

const FEATURE_DEFAULTS: Record<string, (p: PredictInput) => number> = {
  p01_mean: () => 22.0,
  p01_std: (p) => (p.high_stress_minutes > 0 ? 2.5 : 1.2),
  p01_max: () => 24.0,
  p01_p95: () => 23.5,
  p02_mean: () => 0.5,
  p02_std: () => 0.1,
  p01_p02_spread: () => 21.5,
  t01_mean: () => 20.0,
  t02_mean: () => 20.0,
  t03_mean: () => 20.0,
  t04_mean: () => 22.0,
  t05_mean: () => 24.0,
  t04_t05_spread: () => -2.0,
  t_left_right_spread: () => 0.0,
  t04_slope: () => 0.0,
  t05_slope: () => 0.0,
  active_minutes: (p) => p.active_runtime_minutes,
  high_stress_minutes: (p) => p.high_stress_minutes,
  cumulative_pressure_stress: (p) => p.cumulative_pressure_stress,
  runtime_minutes: (p) => p.active_runtime_minutes,
};

export type ModelFeatureOverrides = Partial<Record<string, number>>;

function buildFeatureVector(
  featureNames: string[],
  input: PredictInput,
  overrides: ModelFeatureOverrides = {},
): number[] {
  return featureNames.map((name) => {
    if (overrides[name] !== undefined) return overrides[name] as number;
    const dflt = FEATURE_DEFAULTS[name];
    return dflt ? dflt(input) : 0;
  });
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export type ModelPrediction = Prediction & {
  source: "model" | "heuristic";
  model_trained_at?: string;
  predicted_failure_mode?: string;
  predicted_failure_confidence?: number;
  model_ttf_minutes?: number;
};

/**
 * Score a single part. Uses the trained model when available, falls back
 * to the heuristic predictor otherwise. The returned shape is a superset
 * of Prediction so callers can swap implementations without changing the
 * dashboard.
 */
export async function predictForPartWithModel(
  input: PredictInput,
  overrides?: ModelFeatureOverrides,
): Promise<ModelPrediction> {
  const heuristic = predictForPart(input);
  const bundle = await loadModel();
  if (!bundle || (!bundle.regressor && !bundle.classifier)) {
    return { ...heuristic, source: "heuristic" };
  }

  const x = buildFeatureVector(bundle.feature_names, input, overrides);

  let modelTtf: number | undefined;
  if (bundle.regressor) {
    modelTtf = Math.max(0, Math.round(scoreRegressor(bundle.regressor, x)));
  }

  let predictedMode: string | undefined;
  let modeConf: number | undefined;
  if (bundle.classifier) {
    const probs = scoreClassifier(bundle.classifier, x);
    let argmax = 0;
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > probs[argmax]) argmax = i;
    }
    predictedMode = bundle.classifier.classes[argmax];
    modeConf = Math.round(probs[argmax] * 1000) / 1000;
  }

  // Blend: if the model's TTF predicts service-soon, lift the heuristic
  // risk score so the dashboard reflects the model's stronger signal.
  let blendedScore = heuristic.risk_score;
  if (modelTtf !== undefined) {
    const ceiling = input.failure_threshold_min ?? input.expected_mtbf_minutes ?? null;
    if (ceiling && ceiling > 0) {
      const modelRatio = 1 - Math.max(0, modelTtf) / ceiling;
      const lifted = Math.round(modelRatio * 100);
      blendedScore = Math.max(blendedScore, Math.min(100, lifted));
    }
  }

  return {
    ...heuristic,
    source: "model",
    risk_score: blendedScore,
    eta_minutes: modelTtf ?? heuristic.eta_minutes,
    model_trained_at: bundle.trained_at,
    predicted_failure_mode: predictedMode,
    predicted_failure_confidence: modeConf,
    model_ttf_minutes: modelTtf,
  };
}

export async function predictBatchWithModel(
  inputs: PredictInput[],
  overrides?: ModelFeatureOverrides,
): Promise<ModelPrediction[]> {
  const out: ModelPrediction[] = [];
  for (const i of inputs) {
    out.push(await predictForPartWithModel(i, overrides));
  }
  return out.sort((a, b) => b.risk_score - a.risk_score);
}
