#!/usr/bin/env node
/* Integrity checks for assets/js/data.js. Runs in CI before every deploy.
 *
 *   node scripts/validate-data.js                 structural checks (offline)
 *   node scripts/validate-data.js --check-images  also HEAD every icon URL
 *
 * Exits non-zero on any error so a broken edit never reaches GitHub Pages.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'assets', 'js', 'data.js');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
const data = sandbox.window.MCMAP_DATA;

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

if (!data || !data.graph || !data.branches || !data.tiers) {
  console.error('data.js must define window.MCMAP_DATA = { tiers, graph, branches }');
  process.exit(1);
}

const { colors, labels } = data.tiers;
const allIds = new Map(); // id -> where it is defined
const images = new Set();

function checkNode(n, where) {
  if (!n.id) return err(`${where}: node without id`);
  if (allIds.has(n.id)) err(`${where}: duplicate id "${n.id}" (also in ${allIds.get(n.id)})`);
  allIds.set(n.id, where);
  if (!n.label) err(`${where}/${n.id}: missing label`);
  if (!colors[n.tier]) err(`${where}/${n.id}: tier "${n.tier}" has no colour in tiers.colors`);
  if (!labels[n.tier]) err(`${where}/${n.id}: tier "${n.tier}" has no label in tiers.labels`);
  if (!n.desc) warn(`${where}/${n.id}: empty description`);
  if (n.image) {
    if (!/^https:\/\//.test(n.image)) err(`${where}/${n.id}: image must be an https URL`);
    images.add(n.image);
  } else if (n.kind !== 'root') {
    warn(`${where}/${n.id}: no icon (renders as a flat colour tile)`);
  }
}

// ---- main graph ----
const main = data.graph;
main.nodes.forEach((n) => checkNode(n.data, 'graph'));
const mainIds = new Set(main.nodes.map((n) => n.data.id));
const degree = {};
const seenEdges = new Set();
main.edges.forEach((e, i) => {
  const { source, target, note } = e.data;
  if (!mainIds.has(source)) err(`graph edge #${i}: unknown source "${source}"`);
  if (!mainIds.has(target)) err(`graph edge #${i}: unknown target "${target}"`);
  if (source === target) err(`graph edge #${i}: self-loop on "${source}"`);
  const key = source + '>' + target;
  if (seenEdges.has(key)) err(`graph: duplicate edge ${key}`);
  seenEdges.add(key);
  // "degree" drives node size and hub placement; it deliberately counts only
  // item-to-item links, not the dashed links out to network roots
  if (note !== 'expand') {
    degree[source] = (degree[source] || 0) + 1;
    degree[target] = (degree[target] || 0) + 1;
  }
});
main.nodes.forEach(({ data: n }) => {
  if (n.kind === 'root') return;
  const actual = degree[n.id] || 0;
  if ((n.degree || 0) !== actual) warn(`graph/${n.id}: degree is ${n.degree}, edges say ${actual}`);
});

// ---- branch networks ----
Object.keys(data.branches).forEach((key) => {
  const b = data.branches[key];
  const where = 'branches.' + key;
  const root = main.nodes.find((n) => n.data.id === b.rootId);
  if (!root) err(`${where}: rootId "${b.rootId}" is not a node in the main graph`);
  else if (root.data.branchKey !== key) err(`${where}: root node's branchKey is "${root.data.branchKey}"`);
  if (!mainIds.has(b.anchor)) err(`${where}: anchor "${b.anchor}" is not a node in the main graph`);
  if (b.count !== b.nodes.length) err(`${where}: count says ${b.count} but there are ${b.nodes.length} nodes`);
  b.nodes.forEach((n) => checkNode(n, where));
  const ids = new Set(b.nodes.map((n) => n.id));
  b.edges.forEach((e, i) => {
    const okS = ids.has(e.source) || e.source === b.rootId;
    const okT = ids.has(e.target) || e.target === b.rootId;
    if (!okS) err(`${where} edge #${i}: unknown source "${e.source}"`);
    if (!okT) err(`${where} edge #${i}: unknown target "${e.target}"`);
  });
});

async function checkImages() {
  const list = [...images];
  const bad = [];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const url = list[i++];
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (!res.ok) bad.push(res.status + ' ' + url);
      } catch (e) {
        bad.push('ERR ' + url + ' (' + e.message + ')');
      }
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  bad.forEach((b) => err('broken icon: ' + b));
}

(async () => {
  if (process.argv.includes('--check-images')) await checkImages();
  warnings.forEach((w) => console.warn('warn  ' + w));
  errors.forEach((e) => console.error('error ' + e));
  const nb = Object.values(data.branches).reduce((s, b) => s + b.nodes.length, 0);
  console.log(`${main.nodes.length} map nodes, ${main.edges.length} links, ` +
    `${Object.keys(data.branches).length} networks (${nb} nodes), ${images.size} icons — ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
})();
