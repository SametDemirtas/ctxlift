import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJUnit } from "../src/runners/junit.ts";

const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">
<testcase classname="tests.test_a" name="test_ok" time="0.1" />
<testcase classname="tests.test_a" name="test_bad" time="0.1"><failure message="assert 1 == 2">trace</failure></testcase>
<testcase classname="tests.test_a" name="test_err"><error message="boom">x</error></testcase>
<testcase classname="tests.test_a" name="test_skip"><skipped type="pytest.skip" message="no">s</skipped></testcase>
<testcase classname="tests.test_a.TestX" name="test_param[a&amp;b-&quot;q&quot;]" time="0"></testcase>
<testcase classname="tests.test_a" name="test_out"><system-out>hello &lt;b&gt;</system-out></testcase>
</testsuite></testsuites>`;

test("parses pass, failure, error and skips skipped", () => {
  const r = parseJUnit(xml);
  assert.equal(r.get("tests.test_a::test_ok"), "pass");
  assert.equal(r.get("tests.test_a::test_bad"), "fail");
  assert.equal(r.get("tests.test_a::test_err"), "fail");
  assert.equal(r.has("tests.test_a::test_skip"), false);
  assert.equal(r.get("tests.test_a::test_out"), "pass");
});

test("decodes entities in parametrized names and does not confuse name with classname", () => {
  const r = parseJUnit(xml);
  assert.equal(r.get('tests.test_a.TestX::test_param[a&b-"q"]'), "pass");
  assert.equal(r.size, 5);
});

test("a test reported twice with a failure stays failed", () => {
  const twice = `<testcase classname="m" name="t"><error message="teardown"/></testcase><testcase classname="m" name="t" />`;
  assert.equal(parseJUnit(twice).get("m::t"), "fail");
  const reversed = `<testcase classname="m" name="t" /><testcase classname="m" name="t"><failure/></testcase>`;
  assert.equal(parseJUnit(reversed).get("m::t"), "fail");
});

test("empty report gives no tests", () => {
  assert.equal(parseJUnit("<testsuites></testsuites>").size, 0);
});
