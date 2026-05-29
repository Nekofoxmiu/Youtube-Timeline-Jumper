import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

function profileConfig(profile) {
  if (profile === 'live-pcm30') {
    return {
      profile,
      currentVariant: 'pcm-current',
      candidateVariant: 'pcm-candidate-model',
      noFilterVariant: 'pcm-no-filter',
    };
  }
  if (profile === 'live-realtime-aed60') {
    return {
      profile,
      currentVariant: 'aed60-current',
      candidateVariant: 'aed60-candidate-model',
      noFilterVariant: 'aed60-no-filter',
    };
  }
  throw new Error(`Unsupported live profile "${profile}". Use live-pcm30 or live-realtime-aed60.`);
}

function runCommand(command, args, { cwd, label, dryRun }) {
  console.log(`[live-profile-replacement-gate] ${label}: ${command} ${args.join(' ')}`);
  if (dryRun) return Promise.resolve();
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

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const profile = String(args.profile || 'live-pcm30');
  const config = profileConfig(profile);
  const candidateDir = args['candidate-segment-filter-model-dir']
    ? String(args['candidate-segment-filter-model-dir'])
    : null;
  if (!candidateDir) {
    throw new Error('--candidate-segment-filter-model-dir is required for replacement gating.');
  }

  const outDir = resolve(String(args['out-dir'] || `training_runs/${profile.replaceAll('-', '_')}_replacement_gate`));
  const jobs = String(args.jobs || 3);
  const force = boolArg(args.force);
  const dryRun = boolArg(args['dry-run']);
  const pythonCommand = String(args.python || 'python');
  const variants = [
    config.currentVariant,
    config.candidateVariant,
    config.noFilterVariant,
  ].join(',');
  const gateVariants = [
    config.currentVariant,
    config.candidateVariant,
  ].join(',');
  const commonLimits = {
    maxMeanF1Drop: args['max-mean-f1-drop'] ?? '0.001',
    maxCandidateCurrentMeanF1Drop: args['max-candidate-current-mean-f1-drop'] ?? args['max-mean-f1-drop'] ?? '0.001',
    maxNoSongIncreaseSec: args['max-no-song-increase-sec'] ?? '0.001',
  };

  await mkdir(outDir, { recursive: true });
  const commands = [];

  commands.push({
    label: 'validate-candidate-profile-assets',
    command: pythonCommand,
    args: [
      'tools/validate_profile_assets.py',
      '--models-dir',
      candidateDir,
      '--profile',
      profile,
      '--require-post-end-guard-metadata',
    ],
  });

  const qualityArgs = [
    'tools/live/run_live_quality_gate.mjs',
    '--sample-count',
    String(args['sample-count'] || 3),
    '--sample-seed',
    String(args['sample-seed'] || 'live-quality-gate'),
    '--jobs',
    jobs,
    '--variants',
    variants,
    '--baseline',
    config.noFilterVariant,
    '--candidate-segment-filter-model-dir',
    candidateDir,
    '--max-mean-f1-drop',
    commonLimits.maxMeanF1Drop,
    '--max-candidate-current-mean-f1-drop',
    commonLimits.maxCandidateCurrentMeanF1Drop,
    '--max-no-song-increase-sec',
    commonLimits.maxNoSongIncreaseSec,
    '--out-dir',
    `${outDir}/sampled_quality_gate`,
  ];
  if (force) qualityArgs.push('--force');
  if (boolArg(args['skip-package'])) qualityArgs.push('--skip-package');
  if (boolArg(args['require-post-end-guard-metadata'])) qualityArgs.push('--require-post-end-guard-metadata');
  commands.push({ label: 'sampled-quality-gate', command: process.execPath, args: qualityArgs });

  const suiteArgs = [
    'tools/live/run_live_regression_suite.mjs',
    '--out-dir',
    `${outDir}/suite`,
    '--variants',
    variants,
    '--gate-variants',
    gateVariants,
    '--baseline',
    config.noFilterVariant,
    '--candidate-segment-filter-model-dir',
    candidateDir,
    '--max-mean-f1-drop',
    commonLimits.maxMeanF1Drop,
    '--max-candidate-current-mean-f1-drop',
    commonLimits.maxCandidateCurrentMeanF1Drop,
    '--max-no-song-increase-sec',
    commonLimits.maxNoSongIncreaseSec,
    '--require-profile-assets',
    '--fail-on-regression',
    '--jobs',
    jobs,
  ];
  if (force) suiteArgs.push('--force');
  commands.push({ label: 'primary-stop-snapshot-no-song-suite', command: process.execPath, args: suiteArgs });

  await writeFile(
    resolve(outDir, 'live_profile_replacement_gate_plan.json'),
    `${JSON.stringify({ profile, candidateDir, outDir, commands }, null, 2)}\n`,
    'utf8'
  );

  for (const item of commands) {
    await runCommand(item.command, item.args, { cwd, label: item.label, dryRun });
  }
  if (!dryRun) {
    const sampledSummary = resolve(outDir, 'sampled_quality_gate', 'live_pcm_ab_summary.json');
    const suiteSummary = resolve(outDir, 'suite', 'live_regression_suite_summary.json');
    const sampledPayload = await readJsonIfExists(sampledSummary);
    const suitePayload = await readJsonIfExists(suiteSummary);
    const payload = {
      passed: true,
      profile,
      candidateDir,
      outDir,
      sampledSummary,
      suiteSummary,
      sampledGate: sampledPayload
        ? {
          variants: sampledPayload.variants || [],
          aggregates: sampledPayload.aggregates || {},
          regression: sampledPayload.regression || [],
          candidateCurrentRegression: sampledPayload.candidateCurrentRegression || [],
          candidateCurrentNoSongRegression: sampledPayload.candidateCurrentNoSongRegression || [],
        }
        : null,
      suiteGate: suitePayload
        ? {
          passed: Boolean(suitePayload.passed),
          normalGate: suitePayload.normalGate || null,
          extendedGate: suitePayload.extendedGate || null,
          stopGate: suitePayload.stopGate || null,
          snapshotGates: suitePayload.gates || null,
          snapshotRegression: suitePayload.regression || null,
          hardNegativeGate: suitePayload.hardNegativeGate || null,
          requireProfileAssets: Boolean(suitePayload.requireProfileAssets),
        }
        : null,
    };
    await writeFile(
      resolve(outDir, 'live_profile_replacement_gate_summary.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    );
  }
  console.log(`[live-profile-replacement-gate] PASS profile=${profile}`);
}

main().catch((error) => {
  console.error(`[live-profile-replacement-gate] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
