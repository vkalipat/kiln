import { expect, test } from "bun:test";
import { resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/benchmarks/vcc-smoke.py");
function runPython(body: string) {
  const bootstrap = "import importlib.util, sys, json, hashlib\ns=importlib.util.spec_from_file_location('vcc_smoke',sys.argv[1])\nm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\n";
  const run = Bun.spawnSync(["python3", "-c", bootstrap + body, script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(run.exitCode).toBe(0);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}
test("VCC smoke rejects unpinned fixture bytes before executing any upstream code", () => {
  const result = runPython("blocked=False\ntry: m.fixture_ast(b'raise RuntimeError(\"unreviewed fixture\")')\nexcept ValueError: blocked=True\nprint(json.dumps({'blocked':blocked,'version':m.PACKAGE_VERSION}))\n");
  expect(result).toEqual({ blocked: true, version: "0.16.0" });
});
test("fixture loader extracts only the reviewed function and literal effects, without pytest or unrelated code", () => {
  const result = runPython("source=b'_GRADED_EFFECTS=((1,2,3.0,4.0),)\\nraise RuntimeError(\"must not execute whole file\")\\n@pytest.fixture\\ndef graded_counts_real():\\n    return _GRADED_EFFECTS\\n'\nm.FIXTURE_SHA256=hashlib.sha256(source).hexdigest()\ntree,effects=m.fixture_ast(source)\nns={'_GRADED_EFFECTS':effects}\nexec(compile(tree,'synthetic-test-fixture','exec'),ns)\nprint(json.dumps({'result':ns['graded_counts_real'](),'nodes':len(tree.body),'decorators':len(tree.body[0].decorator_list)}))\n");
  expect(result).toEqual({ result: [[1, 2, 3, 4]], nodes: 1, decorators: 0 });
});
test("missing and nonfinite official metric values cannot become a successful smoke score", () => {
  const result = runPython("rows=[{'metric':name,'value':1.0} for name in sorted(m.SCORED_METRICS)]\nvalid=m.check_metric_table(rows)\nmissing=m.check_metric_table(rows[:-1])\nbad=[]\nfor value in [float('nan'),float('inf'),None,True,'1']:\n    altered=[dict(r) for r in rows]\n    altered[0]['value']=value\n    bad.append(m.check_metric_table(altered)['completeAndFinite'])\naggregate=m.check_metric_table([{'metric':r['metric'],'mean':r['value']} for r in rows],value_field='mean')\nprint(json.dumps({'valid':valid['completeAndFinite'],'missing':missing['completeAndFinite'],'bad':bad,'aggregate':aggregate['completeAndFinite']}))\n");
  expect(result).toEqual({ valid: true, missing: false, bad: [false, false, false, false, false], aggregate: true });
});
