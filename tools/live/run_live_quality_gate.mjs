import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const values = [];
    while (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      values.push(argv[index + 1]);
      index += 1;
    }
    args[key] = values.length > 1 ? values : values[0] ?? true;
  }
  return args;
}

function boolArg(value) {
  return value === true || value === 'true' || value === '1';
}

function optionalPush(args, key, value) {
  if (value === undefined || value === null || value === false || value === '') return;
  if (value === true) {
    args.push(key);
    return;
  }
  args.push(key, String(value));
}

function positiveInteger(value, fallback) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.min(999, num));
}

function safeName(value) {
  const text = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return text || 'default';
}

function hashSeed(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seedText) {
  let state = hashSeed(seedText) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleItems(items, count, seedText) {
  const random = seededRandom(seedText);
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, count);
}

function runCommand(command, args, { cwd, label }) {
  console.log(`[live-quality-gate] ${label}: ${command} ${args.join(' ')}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

async function nodeCheckScripts(repoRoot) {
  const liveDir = join(repoRoot, 'tools', 'live');
  const liveScripts = (await readdir(liveDir))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => join('tools', 'live', name));
  const runtimeDir = join(repoRoot, 'lib', 'songDetection');
  const runtimeScripts = (await readdir(runtimeDir))
    .filter((name) => name.endsWith('.js'))
    .map((name) => join('lib', 'songDetection', name));
  const scripts = [
    ...runtimeScripts,
    'offscreen.js',
    'tools/audit_detection_pipeline_contracts.mjs',
    'tools/simulate_live_pcm_detection.mjs',
    'tools/simulate_live_smoothing.mjs',
    'tools/run_global_smoothing.mjs',
    ...liveScripts,
  ];
  for (const script of scripts) {
    await runCommand(process.execPath, ['--check', script], {
      cwd: repoRoot,
      label: `node-check ${script}`,
    });
  }
}

async function auditDetectionPipelines(repoRoot) {
  await runCommand(process.execPath, [
    'tools/audit_detection_pipeline_contracts.mjs',
  ], {
    cwd: repoRoot,
    label: 'audit-detection-pipelines',
  });
}

async function pythonCompile(repoRoot, pythonCommand) {
  await runCommand(pythonCommand, [
    '-m',
    'py_compile',
    'tools/evaluate_smoothing_batch.py',
    'tools/train_segment_filter.py',
    'tools/validate_profile_assets.py',
    'tools/validate_training_annotations.py',
  ], {
    cwd: repoRoot,
    label: 'python-compile',
  });
}

async function validateProfileAssets(repoRoot, pythonCommand, args) {
  const commandArgs = [
    'tools/validate_profile_assets.py',
  ];
  if (boolArg(args['require-post-end-guard-metadata'])) {
    commandArgs.push('--require-post-end-guard-metadata');
  }
  await runCommand(pythonCommand, commandArgs, {
    cwd: repoRoot,
    label: 'validate-profile-assets',
  });
}

async function validateAnnotations(repoRoot, pythonCommand) {
  await runCommand(pythonCommand, [
    'tools/validate_training_annotations.py',
    '--annotations',
    'tools/annotations_example.csv',
    '--manual-dir',
    'tools/data/manual',
  ], {
    cwd: repoRoot,
    label: 'validate-training-annotations',
  });
}

async function packageCheck(repoRoot) {
  await runCommand('powershell.exe', [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'tools\\package_extension.ps1',
    '-NoZip',
  ], {
    cwd: repoRoot,
    label: 'package-check',
  });
}

async function readSampleIds(samplePath) {
  const sourceItems = JSON.parse(await readFile(samplePath, 'utf8'));
  if (!Array.isArray(sourceItems)) {
    throw new Error(`Sample source must be a JSON array: ${samplePath}`);
  }
  return {
    items: sourceItems,
    ids: sourceItems.map((item) => item?.id || 'unknown'),
  };
}

async function resolveSamplesPath(repoRoot, args, outDir) {
  if (args.samples) {
    const samplePath = String(args.samples);
    const samplePathAbs = resolve(repoRoot, samplePath);
    const { ids } = await readSampleIds(samplePathAbs);
    console.log(`[live-quality-gate] explicit samples count=${ids.length}: ${ids.join(', ')}`);
    return {
      path: samplePath,
      ids,
      generated: false,
    };
  }

  const sampleSource = String(args['sample-source'] || 'tools/samples/live/live_pcm_full_regression_samples.example.json');
  const sampleCount = positiveInteger(args['sample-count'], 3);
  const sampleSeed = String(args['sample-seed'] || 'live-quality-gate');
  const sourcePath = resolve(repoRoot, sampleSource);
  const { items: sourceItems } = await readSampleIds(sourcePath);
  if (sourceItems.length < sampleCount) {
    throw new Error(`Sample source has only ${sourceItems.length} sample(s), requested ${sampleCount}.`);
  }
  if (sampleCount < 3) {
    throw new Error(`Live quality gate requires at least 3 samples, got ${sampleCount}.`);
  }

  const selected = sampleItems(sourceItems, sampleCount, sampleSeed);
  const selectedIds = selected.map((item) => item?.id || 'unknown');
  const outDirAbs = resolve(repoRoot, outDir);
  await mkdir(outDirAbs, { recursive: true });
  const selectedPath = join(outDirAbs, `selected_samples_${safeName(sampleSeed)}_${sampleCount}.json`);
  await writeFile(selectedPath, `${JSON.stringify(selected, null, 2)}\n`, 'utf8');
  console.log(`[live-quality-gate] selected samples seed=${sampleSeed} count=${sampleCount}: ${selectedIds.join(', ')}`);
  console.log(`[live-quality-gate] selected sample file: ${selectedPath}`);
  return {
    path: selectedPath,
    ids: selectedIds,
    generated: true,
    sampleSeed,
    sampleSource,
  };
}

async function livePcmAb(repoRoot, args) {
  const candidateModelDir = args['candidate-segment-filter-model-dir']
    ? String(args['candidate-segment-filter-model-dir'])
    : null;
  const outDir = String(args['out-dir'] || 'training_runs/live_pcm_quality_gate_sampled_ab');
  const samplePlan = await resolveSamplesPath(repoRoot, args, outDir);
  const variants = args.variants
    ? String(args.variants)
    : (candidateModelDir ? 'pcm-current,pcm-candidate-model,pcm-no-filter' : 'pcm-current,pcm-no-filter');
  const commandArgs = [
    'tools/live/run_live_pcm_ab_samples.mjs',
    '--samples',
    samplePlan.path,
    '--variants',
    variants,
    '--baseline',
    String(args.baseline || 'pcm-no-filter'),
    '--out-dir',
    outDir,
    '--jobs',
    String(args.jobs || 3),
    '--fail-on-regression',
    '--require-profile-assets',
  ];
  optionalPush(commandArgs, '--segment-filter-model-dir', args['segment-filter-model-dir']);
  optionalPush(commandArgs, '--candidate-segment-filter-model-dir', candidateModelDir);
  optionalPush(commandArgs, '--max-mean-f1-drop', args['max-mean-f1-drop']);
  optionalPush(commandArgs, '--max-candidate-current-mean-f1-drop', args['max-candidate-current-mean-f1-drop']);
  optionalPush(commandArgs, '--max-no-song-increase-sec', args['max-no-song-increase-sec']);
  if (boolArg(args.force)) commandArgs.push('--force');

  await runCommand(process.execPath, commandArgs, {
    cwd: repoRoot,
    label: 'live-pcm-ab',
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..', '..');
  const pythonCommand = String(args.python || 'python');

  if (boolArg(args['sample-plan-only'])) {
    const outDir = String(args['out-dir'] || 'training_runs/live_pcm_quality_gate_sampled_ab');
    const samplePlan = await resolveSamplesPath(repoRoot, args, outDir);
    console.log(
      `[live-quality-gate] sample plan only; no static checks, package check, or PCM A/B were run. `
      + `samples=${samplePlan.ids.join(', ')}`
    );
    return;
  }

  await nodeCheckScripts(repoRoot);
  await auditDetectionPipelines(repoRoot);
  await pythonCompile(repoRoot, pythonCommand);
  await validateProfileAssets(repoRoot, pythonCommand, args);
  await validateAnnotations(repoRoot, pythonCommand);
  if (!boolArg(args['skip-package'])) {
    await packageCheck(repoRoot);
  }
  await livePcmAb(repoRoot, args);
  console.log('[live-quality-gate] PASS');
}

main().catch((error) => {
  console.error(`[live-quality-gate] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
