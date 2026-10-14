import test from "node:test";
import assert from "node:assert/strict";
import { canManageContent, canManageRole, rolesVisibleTo } from "./permissions.js";

test("developers can only manage administrator accounts", () => {
  assert.equal(canManageRole("developer", "admin"), true);
  assert.equal(canManageRole("developer", "teacher"), false);
  assert.equal(canManageRole("developer", "student"), false);
  assert.equal(canManageRole("developer", "developer"), false);
});

test("administrators can manage school roles but cannot create developers", () => {
  assert.equal(canManageRole("admin", "admin"), true);
  assert.equal(canManageRole("admin", "teacher"), true);
  assert.equal(canManageRole("admin", "student"), true);
  assert.equal(canManageRole("admin", "developer"), false);
});

test("teachers can manage student accounts only", () => {
  assert.equal(canManageRole("teacher", "student"), true);
  assert.equal(canManageRole("teacher", "teacher"), false);
  assert.equal(canManageRole("teacher", "admin"), false);
});

test("account lists are scoped to each manager role", () => {
  assert.deepEqual(rolesVisibleTo("developer"), ["admin"]);
  assert.deepEqual(rolesVisibleTo("admin"), ["admin", "teacher", "student"]);
  assert.deepEqual(rolesVisibleTo("teacher"), ["student"]);
  assert.equal(rolesVisibleTo("student"), null);
});

test("teachers can manage their own posts and tasks while admins can moderate all", () => {
  assert.equal(canManageContent("teacher", "42", 42), true);
  assert.equal(canManageContent("teacher", 42, 17), false);
  assert.equal(canManageContent("admin", 42, 17), true);
  assert.equal(canManageContent("student", 42, 17), false);
});
