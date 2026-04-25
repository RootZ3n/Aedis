import test from "node:test";
import assert from "node:assert/strict";
import { classifyTaskShape, routeStrategyDirective } from "./task-shape.js";

test("task-shape: bare HTTP verb + path triggers route-add", () => {
  const f = classifyTaskShape("add GET /health endpoint to the server");
  assert.equal(f.shape, "route-add");
  assert.deepEqual([...f.httpVerbs], ["GET"]);
  assert.deepEqual([...f.httpPaths], ["/health"]);
});

test("task-shape: 'add a /models endpoint' (no verb) triggers route-add via path+endpoint noun", () => {
  const f = classifyTaskShape("add a /models endpoint that lists configured models");
  assert.equal(f.shape, "route-add");
  assert.deepEqual([...f.httpPaths], ["/models"]);
});

test("task-shape: lowercase verb still detected", () => {
  const f = classifyTaskShape("please add a get /v1/chat handler");
  assert.equal(f.shape, "route-add");
  assert.ok(f.httpVerbs.includes("GET"));
});

test("task-shape: refactor without endpoint stays general", () => {
  // This prompt has neither HTTP nouns/verbs nor extract/share+type+module
  // signals, so it falls through to general.
  const f = classifyTaskShape("clean up the router internals and remove dead branches");
  assert.equal(f.shape, "general");
});

test("task-shape: file path with extension is NOT mistaken for an HTTP path", () => {
  const f = classifyTaskShape("modify src/routes/health.ts to log uptime");
  assert.equal(f.shape, "general");
});

test("task-shape: config-update detected", () => {
  const f = classifyTaskShape("update timeout config to 60 seconds");
  assert.equal(f.shape, "config-update");
});

test("task-shape: type-sharing detected", () => {
  const f = classifyTaskShape("extract the user interface into a shared type");
  assert.equal(f.shape, "type-sharing");
});

test("task-shape: type-extend detector is case-insensitive", () => {
  const f = classifyTaskShape("Add email:string to User interface");
  assert.equal(f.shape, "type-extend");
  assert.equal(f.typeExtend?.symbol, "User");
  assert.equal(f.typeExtend?.property, "email");
  assert.equal(f.typeExtend?.propertyType, "string");
});

test("task-shape: routeStrategyDirective is empty for non-route tasks", () => {
  assert.equal(routeStrategyDirective(classifyTaskShape("refactor stuff")), "");
});

test("task-shape: routeStrategyDirective names verb+path on route-add", () => {
  const directive = routeStrategyDirective(classifyTaskShape("add POST /chat endpoint"));
  assert.match(directive, /ROUTE-ADD STRATEGY/);
  assert.match(directive, /POST/);
  assert.match(directive, /\/chat/);
  assert.match(directive, /INSERT the new handler BESIDE/);
  assert.match(directive, /Preserve every existing top-level export/);
});

test("task-shape: empty/null input returns general", () => {
  assert.equal(classifyTaskShape("").shape, "general");
  assert.equal(classifyTaskShape(null).shape, "general");
  assert.equal(classifyTaskShape(undefined).shape, "general");
});
