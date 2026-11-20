import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTicket02App } from "../server/app.js";
import { ImageEditorService, MemoryImageEditorRepository, type ImageEditProvider } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { MemoryReverseRepository } from "../server/repositories/memory-reverse-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

const fakeProvider: ImageEditProvider = {
  name: "fake",
  version: "1",
  capabilitiesVersion: "v1",
  capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
  async edit() { throw new Error("not used in cross-device contract test"); },
};

test("a fresh browser session reads suites and reverse plans from the server repositories", async () => {
  const suites = new MemorySuiteRepository();
  const reversePlans = new MemoryReverseRepository();
  // First browser session creates records through the API.
  const firstBrowser = createTicket02App({ repository: suites, storage: new MemoryStorage(), reverseRepository: reversePlans });
  const createdSuite = await firstBrowser.request("POST", "/api/suites", { headers: { "idempotency-key": "cross-device-suite" }, body: { name: "跨设备套图" } });
  assert.equal(createdSuite.status, 201);
  const suiteId = (createdSuite.body as { data: { id: string } }).data.id;
  const createdPlan = await firstBrowser.request("POST", "/api/reverse-plans", { headers: { "idempotency-key": "cross-device-reverse" }, body: { mode: "main" } });
  assert.equal(createdPlan.status, 201);
  const planId = (createdPlan.body as { data: { id: string } }).data.id;

  // New app instance, no cookie/header/localStorage: only the shared server store survives.
  const secondBrowser = createTicket02App({ repository: suites, storage: new MemoryStorage(), reverseRepository: reversePlans });
  const suitesResponse = await secondBrowser.request("GET", "/api/suites");
  assert.equal(suitesResponse.status, 200);
  const suiteList = (suitesResponse.body as { data: Array<{ id: string; name: string }> }).data;
  assert.ok(suiteList.some((suite) => suite.id === suiteId && suite.name === "跨设备套图"), "recent suite list must come from the server repository");

  const plansResponse = await secondBrowser.request("GET", "/api/reverse-plans");
  assert.equal(plansResponse.status, 200);
  const planList = (plansResponse.body as { data: Array<{ id: string }> }).data;
  assert.ok(planList.some((plan) => plan.id === planId), "reverse plan list must come from the server repository");
});

test("image edit drafts are keyed by task id and restored by a fresh session", async () => {
  const taskId = "task-cross-device-001";
  const repository = new MemoryImageEditorRepository();
  const firstSession = createImageEditorApi(new ImageEditorService(repository, fakeProvider, new MemoryStorage(), async () => null));
  const saved = await firstSession.request("POST", `/api/image-editor/sessions/${taskId}/operations`, {
    body: {
      operation: {
        operationId: "op-cross-device",
        type: "add_text",
        order: 1,
        sourceCardId: taskId,
        sourceVersionId: "version-1",
        parentVersionId: "version-1",
        summary: "添加卖点文字",
        payload: { text: "跨设备草稿" },
      },
    },
  });
  assert.equal(saved.status, 200);

  const secondSession = createImageEditorApi(new ImageEditorService(repository, fakeProvider, new MemoryStorage(), async () => null));
  const restored = await secondSession.request("GET", `/api/image-editor/sessions/${taskId}`);
  assert.equal(restored.status, 200);
  const draft = (restored.body as { data: { sessionId: string; operations: Array<{ operationId: string; payload: Record<string, unknown> }> } }).data;
  assert.equal(draft.sessionId, taskId);
  assert.equal(draft.operations.length, 1);
  assert.equal(draft.operations[0].operationId, "op-cross-device");
  assert.equal(draft.operations[0].payload.text, "跨设备草稿");
});

test("production wiring uses PostgreSQL/MinIO and sources contain no browser storage records", async () => {
  const indexSource = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
  for (const persistentAdapter of [
    "PostgresSuiteRepository",
    "PostgresReverseRepository",
    "PostgresLibraryRepository",
    "PostgresTaskRepository",
    "PostgresImageEditorRepository",
    "MinioStorage",
  ]) {
    assert.ok(indexSource.includes(`new ${persistentAdapter}`), `server/index.ts must wire ${persistentAdapter}`);
  }

  const forbidden = ["localStorage", "sessionStorage", "indexedDB"];
  const hits: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!/\.(ts|tsx|js|jsx|html)$/.test(entry.name)) continue;
      const source = await readFile(path, "utf8");
      for (const token of forbidden) if (source.includes(token)) hits.push(`${path}: ${token}`);
    }
  };
  await walk(fileURLToPath(new URL("../src", import.meta.url)));
  await walk(fileURLToPath(new URL("../server", import.meta.url)));
  assert.deepEqual(hits, [], `record-level browser storage is not allowed: ${hits.join(", ")}`);

  const workbenchSource = await readFile(new URL("../src/pages/WorkbenchBoardPage.tsx", import.meta.url), "utf8");
  assert.match(workbenchSource, /getImageEditDraft\(task\.id\)/, "frontend must load the draft by task id");
  assert.match(workbenchSource, /upsertImageEditOperation\(task\.id/, "frontend must save the draft by task id");
});
