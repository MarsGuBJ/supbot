const fs = require("node:fs");
const path = require("node:path");

let calculateAutopilotMetrics;
let summarizeAutopilotQuality;
try {
  ({ calculateAutopilotMetrics, summarizeAutopilotQuality } = require("../packages/runtime/dist/index.js"));
} catch (error) {
  console.error("Build @supbot/runtime before running the Autopilot benchmark.", error.message);
  process.exit(1);
}

const directory = path.resolve(__dirname, "../packages/runtime/benchmarks");
const thresholds = JSON.parse(fs.readFileSync(path.join(directory, "thresholds.json"), "utf8"));
const fixtures = fs.readdirSync(directory).filter((file) => file.endsWith(".json") && file !== "thresholds.json").sort().map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
const results = fixtures.map((fixture) => {
  const metrics = calculateAutopilotMetrics(fixture.run, fixture.tasks, fixture.actions, fixture.events, Date.parse(fixture.run.updatedAt));
  const mismatches = Object.entries(fixture.expect).filter(([key, expected]) => metrics[key] !== expected).map(([key, expected]) => ({ key, expected, actual: metrics[key] }));
  return { name: fixture.name, passed: mismatches.length === 0, mismatches, metrics };
});
const quality = summarizeAutopilotQuality(results.map((result) => result.metrics), fixtures.flatMap((fixture) => fixture.tasks), thresholds);
const qualityPassed = quality.regressions.length === 0;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  passed: results.every((result) => result.passed) && qualityPassed,
  thresholds,
  quality,
  scenarios: results
};
const outputArgument = process.argv.indexOf("--output");
const outputPath = outputArgument >= 0 ? process.argv[outputArgument + 1] : process.env.AUTOPILOT_BENCHMARK_REPORT;

if (outputArgument >= 0 && !outputPath) {
  console.error("--output requires a file path");
  process.exit(2);
}

if (outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
    if (result.mismatches.length) console.log(JSON.stringify(result.mismatches));
  }
  console.log(`${qualityPassed ? "PASS" : "FAIL"} quality-thresholds`);
  if (!qualityPassed) console.log(JSON.stringify(quality.regressions));
}

if (!report.passed) process.exitCode = 1;
