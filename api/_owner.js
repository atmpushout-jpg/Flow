// api/_owner.js — personal owner dashboards, assisted lane (write side).
//
// Each assisted owner (e.g. a family investor onboarded by the desk) holds
// ONE personal link: owner.html?t=<token>. The token is the only credential;
// only its SHA-256 hash is ever used as a storage key.
//
// Reads are static snapshots the desk publishes (owners/<hash>.json).
// This module is the request inbox: the owner posts requests from the page
// (set display name, rename a fighter, calibrate one dial, withdraw), the
// desk polls them, applies them to the local registry, and republishes the
// snapshot — which is also how the owner sees a request flip to "applied".
// Requests are append-only from the page; nothing here moves money.

const crypto = require("crypto");
const builderKey = require("./_builderkey");

const KEY_REQ = "flow:owner-req:";
const TOKEN_RE = /^flw_own_[A-Za-z0-9_-]{20,}$/;
const NAME_RE = /^[A-Za-z0-9]{2,10}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DIALS = {
  appetite: ["careful", "balanced", "big"],
  aggression: ["safe", "mixed", "big"],
  patience: ["quick", "standard", "ride"],
};
const TYPES = ["set-name", "rename-fighter", "calibrate", "withdraw"];
const MAX_REQUESTS = 100;

function getStore() {
  return builderKey.getStore();
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function tokenOk(raw) {
  return typeof raw === "string" && TOKEN_RE.test(raw);
}

async function readRequests(store, hash) {
  const raw = await store.get(KEY_REQ + hash);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function validateCreate(input) {
  if (!input || typeof input !== "object") return { status: 400, error: "JSON body required" };
  if (!tokenOk(input.token)) return { status: 401, error: "a valid owner token is required" };
  const type = String(input.type || "");
  if (!TYPES.includes(type)) return { status: 400, error: `type must be one of: ${TYPES.join(", ")}` };
  const payload = {};
  if (type === "set-name") {
    const name = String(input.displayName || "").trim();
    if (name.length < 1 || name.length > 40 || /[\x00-\x1f<>]/.test(name)) {
      return { status: 400, error: "displayName must be 1-40 plain characters" };
    }
    payload.displayName = name;
  }
  if (type === "rename-fighter") {
    const fighter = String(input.fighter || "").toUpperCase();
    const newName = String(input.newName || "").toUpperCase();
    if (!NAME_RE.test(fighter)) return { status: 400, error: "fighter must be a current fighter name" };
    if (!NAME_RE.test(newName)) return { status: 400, error: "newName must be 2-10 letters/numbers" };
    payload.fighter = fighter;
    payload.newName = newName;
  }
  if (type === "calibrate") {
    const fighter = String(input.fighter || "").toUpperCase();
    const dial = String(input.dial || "");
    const to = String(input.to || "");
    if (!NAME_RE.test(fighter)) return { status: 400, error: "fighter must be a current fighter name" };
    if (!DIALS[dial]) return { status: 400, error: "dial must be appetite, aggression, or patience" };
    if (!DIALS[dial].includes(to)) return { status: 400, error: `to must be one of: ${DIALS[dial].join(", ")}` };
    payload.fighter = fighter;
    payload.dial = dial;
    payload.to = to;
  }
  if (type === "withdraw") {
    const amountUsd = Number(input.amountUsd);
    const destination = String(input.destination || "");
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 10000) {
      return { status: 400, error: "amountUsd must be a positive amount" };
    }
    if (!ADDR_RE.test(destination)) return { status: 400, error: "destination must be a wallet address (0x…)" };
    payload.amountUsd = Math.round(amountUsd * 100) / 100;
    payload.destination = destination;
  }
  return { ok: true, type, payload };
}

async function createRequest(store, input) {
  const v = validateCreate(input);
  if (!v.ok) return { status: v.status, body: { error: v.error } };
  const hash = hashToken(input.token);
  const reqs = await readRequests(store, hash);
  if (reqs.length >= MAX_REQUESTS) {
    return { status: 429, body: { error: "request inbox is full — the desk has been notified by size alone; try again later" } };
  }
  const req = {
    id: crypto.randomUUID(),
    type: v.type,
    ...v.payload,
    at: new Date().toISOString(),
  };
  reqs.push(req);
  await store.set(KEY_REQ + hash, JSON.stringify(reqs));
  return { status: 201, body: { ok: true, request: req } };
}

async function listRequests(store, rawToken) {
  if (!tokenOk(rawToken)) return { status: 401, body: { error: "a valid owner token is required" } };
  const reqs = await readRequests(store, hashToken(rawToken));
  return { status: 200, body: { requests: reqs } };
}

module.exports = { getStore, hashToken, tokenOk, createRequest, listRequests, DIALS };
