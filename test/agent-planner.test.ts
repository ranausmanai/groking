import assert from "node:assert/strict";
import test from "node:test";

import { parsePlannedSubtasksText } from "../src/agent.js";

test("parsePlannedSubtasksText parses strict json tasks", () => {
  const tasks = parsePlannedSubtasksText(
    JSON.stringify({
      tasks: [
        { label: "setup", task: "create src folder", scope: ["src/"] },
        { label: "impl", task: "implement feature", scope: ["src/app.ts"], depends_on: ["setup"] }
      ]
    })
  );

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.label, "setup");
  assert.equal(tasks[1]?.depends_on?.[0], "setup");
});

test("parsePlannedSubtasksText ignores unknown dependencies and de-dupes labels", () => {
  const tasks = parsePlannedSubtasksText(
    JSON.stringify({
      tasks: [
        { label: "impl", task: "task one", depends_on: ["missing"] },
        { label: "impl", task: "task two", depends_on: ["impl", "impl-2", "missing"] }
      ]
    })
  );

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.label, "impl");
  assert.equal(tasks[1]?.label, "impl-2");
  assert.deepEqual(tasks[0]?.depends_on, undefined);
  assert.deepEqual(tasks[1]?.depends_on, ["impl"]);
});

test("parsePlannedSubtasksText extracts json from fenced output", () => {
  const tasks = parsePlannedSubtasksText(
    "Here is your plan:\n```json\n{\"tasks\":[{\"label\":\"verify\",\"task\":\"run tests\",\"scope\":[\"test/\"]}]}\n```"
  );

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.label, "verify");
  assert.equal(tasks[0]?.scope?.[0], "test/");
});
