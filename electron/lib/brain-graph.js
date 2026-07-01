'use strict';
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const { getWorkspace } = require('./workspace');
const { getZcaCacheDir } = require('./zalo-memory');
const { withMemoryFileLock } = require('./conversation');

const BRAIN_GRAPH_FILENAME = 'brain-graph.json';

// ─── Helpers ────────────────────────────────────────────────────

function getBrainGraphPath(workspace) {
  return path.join(workspace || getWorkspace(), BRAIN_GRAPH_FILENAME);
}

/**
 * Parse simple YAML frontmatter from a markdown string.
 * Returns null if no frontmatter found.
 * Handles: scalar values, quoted strings, simple arrays (- "item" lines).
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const block = match[1];
  const result = {};
  let currentKey = null;
  let currentArray = null;
  for (const line of block.split(/\r?\n/)) {
    // Array item line: starts with whitespace + dash
    const arrayItem = line.match(/^\s+-\s+"?([^"]*)"?\s*$/);
    if (arrayItem && currentKey && currentArray) {
      currentArray.push(arrayItem[1]);
      continue;
    }
    // Key: value line
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*?)\s*$/);
    if (kv) {
      // Flush previous array
      if (currentKey && currentArray) {
        result[currentKey] = currentArray;
        currentArray = null;
        currentKey = null;
      }
      const key = kv[1];
      let val = kv[2];
      if (val === '') {
        // Could be start of an array — set up for next lines
        currentKey = key;
        currentArray = [];
        continue;
      }
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Parse numbers
      if (/^\d+$/.test(val)) {
        result[key] = parseInt(val, 10);
      } else {
        result[key] = val;
      }
      currentKey = null;
      currentArray = null;
    }
  }
  // Flush trailing array
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }
  return result;
}

/**
 * Replace (or inject) the `links` array in YAML frontmatter.
 * Returns updated content string.
 */
function updateFrontmatterLinks(content, links) {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return content; // no frontmatter — leave untouched

  const before = fmMatch[1];
  let fmBody = fmMatch[2];
  const after = fmMatch[3];
  const rest = content.slice(fmMatch[0].length);
  const nl = fmBody.includes('\r\n') ? '\r\n' : '\n';

  // Remove existing links block (key line + subsequent array item lines)
  const lines = fmBody.split(/\r?\n/);
  const filtered = [];
  let inLinks = false;
  for (const line of lines) {
    if (/^links\s*:/.test(line)) {
      inLinks = true;
      continue;
    }
    if (inLinks && /^\s+-/.test(line)) continue;
    inLinks = false;
    filtered.push(line);
  }
  fmBody = filtered.join(nl);

  // Append new links
  if (links.length > 0) {
    const linksYaml = 'links:' + nl + links.map(l => '  - "' + l + '"').join(nl);
    fmBody = fmBody + nl + linksYaml;
  }

  return before + fmBody + after + rest;
}

/**
 * Tail-read last N bytes of a file. Returns string.
 */
function tailRead(filePath, bytes) {
  try {
    const stat = fs.statSync(filePath);
    const offset = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

// ─── Node Collection ────────────────────────────────────────────

/**
 * Reads memory/zalo-users/*.md, extracts frontmatter.
 * Returns array of node objects.
 */
function collectCustomerNodes(workspace) {
  const nodes = [];
  const dir = path.join(workspace, 'memory', 'zalo-users');
  let files;
  try { files = fs.readdirSync(dir); } catch { return nodes; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const fm = parseFrontmatter(content);
      const fileId = f.replace(/\.md$/, '');
      const label = (fm && fm.name) || (fm && fm.zaloName) || fileId;
      const msgCount = (fm && fm.msgCount) || 1;
      nodes.push({
        id: 'user:' + fileId,
        type: 'customer',
        label: String(label),
        size: Number(msgCount) || 1,
        meta: {
          msgCount: Number(msgCount) || 0,
          gender: (fm && fm.gender) || '',
          lastSeen: (fm && fm.lastSeen) || '',
        },
      });
    } catch (e) {
      console.warn('[brain-graph] skip corrupt customer file:', f, e?.message);
    }
  }
  return nodes;
}

/**
 * Reads memory/zalo-groups/*.md, extracts frontmatter.
 */
function collectGroupNodes(workspace) {
  const nodes = [];
  const dir = path.join(workspace, 'memory', 'zalo-groups');
  let files;
  try { files = fs.readdirSync(dir); } catch { return nodes; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const fm = parseFrontmatter(content);
      const fileId = f.replace(/\.md$/, '');
      const label = (fm && fm.name) || fileId;
      const memberCount = (fm && fm.memberCount) || 1;
      nodes.push({
        id: 'group:' + fileId,
        type: 'group',
        label: String(label),
        size: Number(memberCount) || 1,
        meta: {
          memberCount: Number(memberCount) || 0,
          lastActivity: (fm && fm.lastActivity) || '',
        },
      });
    } catch (e) {
      console.warn('[brain-graph] skip corrupt group file:', f, e?.message);
    }
  }
  return nodes;
}

/**
 * Reads knowledge/{cong-ty,san-pham,nhan-vien,framework,workflow}/files/ directories.
 */
function collectDocNodes(workspace) {
  const nodes = [];
  const categories = ['cong-ty', 'san-pham', 'nhan-vien', 'framework', 'workflow'];
  // Since the v2.4 migration, docs live under files/<public|noi-bo|ceo-only>/.
  // Older installs may still keep files directly under files/. Handle both, and
  // skip directory entries (statSync without isFile() used to add the visibility
  // subfolders themselves as "doc:public/noi-bo/ceo-only" nodes — colliding across
  // all three categories and crashing the layout worker on duplicate node id).
  const visSubfolders = ['public', 'noi-bo', 'ceo-only'];
  // Keep the id as 'doc:<filename>' (no '/') — get-brain-node-detail in
  // dashboard-ipc.js does nodeId.slice(4) and rejects any id containing a slash,
  // then resolves by filename across categories. Dedup by id so the rare same
  // filename in two categories can't add a duplicate node and crash the layout.
  const seen = new Set();
  const addFile = (cat, dir, f) => {
    try {
      const id = 'doc:' + f;
      if (seen.has(id)) return;
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return;
      seen.add(id);
      const sizeKb = stat.size / 1024;
      nodes.push({
        id,
        type: 'doc',
        label: f.replace(/\.[^.]+$/, ''),
        size: Math.max(1, Math.round(sizeKb)),
        meta: { category: cat, filename: f },
      });
    } catch (e) {
      console.warn('[brain-graph] skip corrupt doc file:', f, e?.message);
    }
  };
  for (const cat of categories) {
    const baseDir = path.join(workspace, 'knowledge', cat, 'files');
    let entries;
    try { entries = fs.readdirSync(baseDir); } catch { continue; }
    for (const e of entries) {
      if (visSubfolders.includes(e)) {
        const subDir = path.join(baseDir, e);
        let subFiles;
        try { subFiles = fs.readdirSync(subDir); } catch { continue; }
        for (const sf of subFiles) addFile(cat, subDir, sf);
      } else {
        addFile(cat, baseDir, e);
      }
    }
  }
  return nodes;
}

/**
 * Parses .learnings/LEARNINGS.md for entries matching the format header.
 */
function collectLearningNodes(workspace) {
  const nodes = [];
  const learningsPath = path.join(workspace, '.learnings', 'LEARNINGS.md');
  let content;
  try { content = fs.readFileSync(learningsPath, 'utf-8'); } catch { return nodes; }

  const re = /^### \[(\d{4}-\d{2}-\d{2})\] ID: (L-\d+) \| Area: ([^|]+)\| Priority: (\w+)/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[2].trim();
    const area = m[3].trim();
    const priority = m[4].trim().toLowerCase();
    const sizeMap = { high: 10, medium: 6, low: 3 };
    nodes.push({
      id: 'learning:' + id,
      type: 'learning',
      label: id + ' — ' + area,
      size: sizeMap[priority] || 3,
      meta: { date: m[1], area, priority },
    });
  }
  return nodes;
}

/**
 * Reads user-skills/_registry.json, returns enabled skills.
 */
function collectSkillNodes(workspace) {
  const nodes = [];
  const registryPath = path.join(workspace, 'user-skills', '_registry.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch { return nodes; }

  const skills = Array.isArray(data) ? data : (Array.isArray(data?.skills) ? data.skills : []);
  for (const s of skills) {
    if (!s || !s.id) continue;
    // Include only enabled skills (default: enabled if field absent)
    if (s.enabled === false) continue;
    nodes.push({
      id: 'skill:' + s.id,
      type: 'skill',
      label: s.label || s.name || s.id,
      size: 5,
      meta: { skillId: s.id },
    });
  }
  return nodes;
}

// ─── Edge Collection ────────────────────────────────────────────

/**
 * Reads openzca groups.json cache. For each group, iterates memVerList,
 * strips _0 suffix, matches against customer node IDs.
 */
function collectMembershipEdges(customerNodes, workspace) {
  const edges = [];
  const customerIdSet = new Set(customerNodes.map(n => n.id));

  let groupsData;
  try {
    const groupsPath = path.join(getZcaCacheDir(), 'groups.json');
    if (!fs.existsSync(groupsPath)) return edges;
    groupsData = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
  } catch (e) {
    console.warn('[brain-graph] groups.json read failed:', e?.message);
    return edges;
  }

  const groups = Array.isArray(groupsData) ? groupsData : (Array.isArray(groupsData?.groups) ? groupsData.groups : []);
  for (const g of groups) {
    const groupId = String(g.groupId || g.id || '');
    if (!groupId) continue;
    const groupNodeId = 'group:' + groupId;
    const members = Array.isArray(g.memVerList) ? g.memVerList : [];
    for (const rawMember of members) {
      // memVerList entries have format "userId_0" — strip the suffix
      const memberId = String(rawMember).split('_')[0];
      const userNodeId = 'user:' + memberId;
      if (customerIdSet.has(userNodeId)) {
        edges.push({
          source: userNodeId,
          target: groupNodeId,
          weight: 1,
          type: 'membership',
        });
      }
    }
  }
  return edges;
}

/**
 * For each learning, check if any doc filename appears as substring in the
 * learning body text. Simple substring matching.
 */
function collectProductLearningEdges(docNodes, learningNodes, workspace) {
  const edges = [];
  if (docNodes.length === 0 || learningNodes.length === 0) return edges;

  const learningsPath = path.join(workspace, '.learnings', 'LEARNINGS.md');
  let content;
  try { content = fs.readFileSync(learningsPath, 'utf-8'); } catch { return edges; }

  // Split LEARNINGS.md into per-entry blocks keyed by learning ID
  const blocks = new Map();
  const parts = content.split(/(?=^### \[)/m);
  for (const part of parts) {
    const idMatch = part.match(/^### \[.*?\] ID: (L-\d+)/);
    if (idMatch) {
      blocks.set(idMatch[1], part);
    }
  }

  // Extract just filenames (without extension) for substring matching
  const docFilenames = docNodes.map(n => ({
    nodeId: n.id,
    name: (n.meta && n.meta.filename) ? n.meta.filename.replace(/\.[^.]+$/, '') : n.label,
  }));

  for (const ln of learningNodes) {
    const learningId = ln.id.replace('learning:', '');
    const bodyText = blocks.get(learningId) || '';
    if (!bodyText) continue;
    const bodyLower = bodyText.toLowerCase();
    for (const doc of docFilenames) {
      if (doc.name.length >= 3 && bodyLower.includes(doc.name.toLowerCase())) {
        edges.push({
          source: ln.id,
          target: doc.nodeId,
          weight: 1,
          type: 'reference',
        });
      }
    }
  }
  return edges;
}

/**
 * Tail-read audit.jsonl (last 64KB), filter for escalation_forwarded events.
 * Group by customer ID, return edges with weight = count.
 */
function collectEscalationEdges(workspace) {
  const edges = [];
  const auditPath = path.join(workspace, 'logs', 'audit.jsonl');
  if (!fs.existsSync(auditPath)) return edges;

  const raw = tailRead(auditPath, 65536);
  const lines = raw.split('\n').filter(Boolean);
  const counts = new Map(); // customerId -> count

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry || entry.event !== 'escalation_forwarded') continue;
      const to = entry.to || (entry.meta && entry.meta.to) || '';
      if (!to) continue;
      const customerId = String(to);
      counts.set(customerId, (counts.get(customerId) || 0) + 1);
    } catch {
      // corrupt line — skip
    }
  }

  for (const [customerId, count] of counts) {
    edges.push({
      source: 'user:' + customerId,
      target: 'escalation:ceo',
      weight: count,
      type: 'escalation',
    });
  }
  return edges;
}

/**
 * Parse [[wikilink]] references from customer memory files.
 * Match link targets to group nodes by name substring.
 */
function collectWikilinkEdges(customerNodes, groupNodes, workspace) {
  const edges = [];
  if (customerNodes.length === 0 || groupNodes.length === 0) return edges;

  const groupNameMap = new Map();
  for (const g of groupNodes) {
    if (g.label) groupNameMap.set(g.label.toLowerCase(), g.id);
  }

  const usersDir = path.join(workspace, 'memory', 'zalo-users');
  if (!fs.existsSync(usersDir)) return edges;

  const edgeSet = new Set();
  for (const cn of customerNodes) {
    const userId = cn.id.replace('user:', '');
    const filePath = path.join(usersDir, userId + '.md');
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const links = content.match(/\[\[([^\]]+)\]\]/g);
    if (!links) continue;
    for (const raw of links) {
      const target = raw.slice(2, -2).replace(/^Nhóm:\s*/, '').trim().toLowerCase();
      if (!target) continue;
      for (const [gName, gId] of groupNameMap) {
        if (gName === target || gName.includes(target) || target.includes(gName)) {
          const key = cn.id + '→' + gId;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ source: cn.id, target: gId, weight: 1, type: 'semantic' });
          }
          break;
        }
      }
    }
  }
  return edges;
}

/**
 * Customers sharing >=3 groups get a semantic co-membership edge.
 * Capped at 500 edges to avoid graph explosion.
 */
function collectCoMembershipEdges(membershipEdges) {
  const edges = [];
  const userGroups = new Map();
  for (const e of membershipEdges) {
    if (!userGroups.has(e.source)) userGroups.set(e.source, new Set());
    userGroups.get(e.source).add(e.target);
  }

  const users = [...userGroups.keys()];
  const CAP = 500;
  for (let i = 0; i < users.length && edges.length < CAP; i++) {
    const aGroups = userGroups.get(users[i]);
    if (aGroups.size < 3) continue;
    for (let j = i + 1; j < users.length && edges.length < CAP; j++) {
      const bGroups = userGroups.get(users[j]);
      if (bGroups.size < 3) continue;
      let shared = 0;
      for (const g of aGroups) { if (bGroups.has(g)) shared++; }
      if (shared >= 3) {
        edges.push({ source: users[i], target: users[j], weight: shared, type: 'semantic' });
      }
    }
  }
  return edges;
}

/**
 * Match knowledge doc titles/keywords against customer memory content.
 * If a customer's memory mentions a doc name → semantic edge.
 */
function collectKnowledgeSemanticEdges(customerNodes, docNodes, workspace) {
  const edges = [];
  if (customerNodes.length === 0 || docNodes.length === 0) return edges;

  const docKeywords = docNodes.map(d => ({
    id: d.id,
    terms: (d.label || '').toLowerCase().split(/[\s\-_]+/).filter(t => t.length >= 3),
  })).filter(d => d.terms.length > 0);
  if (docKeywords.length === 0) return edges;

  const usersDir = path.join(workspace, 'memory', 'zalo-users');
  if (!fs.existsSync(usersDir)) return edges;

  const edgeSet = new Set();
  for (const cn of customerNodes) {
    const userId = cn.id.replace('user:', '');
    const filePath = path.join(usersDir, userId + '.md');
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8').toLowerCase(); } catch { continue; }
    if (content.length < 100) continue;

    for (const doc of docKeywords) {
      const matchCount = doc.terms.filter(t => content.includes(t)).length;
      if (matchCount >= 2 || (doc.terms.length === 1 && matchCount === 1)) {
        const key = cn.id + '→' + doc.id;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: cn.id, target: doc.id, weight: matchCount, type: 'semantic' });
        }
      }
    }
  }
  return edges;
}

// ─── Layout ─────────────────────────────────────────────────────

/**
 * Fork brain-layout-worker.js, send nodes+edges, receive positions.
 * Timeout 30s, fallback to random positions.
 */
function runLayout(nodes, edges) {
  return new Promise((resolve) => {
    const workerPath = path.join(__dirname, 'brain-layout-worker.js');
    let resolved = false;

    const done = (positions) => {
      if (resolved) return;
      resolved = true;
      resolve(positions);
    };

    // Fallback: random positions
    const fallbackPositions = () => {
      const positions = {};
      for (const n of nodes) {
        positions[n.id] = { x: Math.random() * 1000, y: Math.random() * 1000 };
      }
      return positions;
    };

    if (nodes.length === 0) {
      done({});
      return;
    }

    let child;
    try {
      child = fork(workerPath, [], { silent: true });
    } catch (e) {
      console.warn('[brain-graph] layout worker fork failed:', e?.message);
      done(fallbackPositions());
      return;
    }

    const timeout = setTimeout(() => {
      console.warn('[brain-graph] layout worker timeout (30s) — using random positions');
      try { child.kill(); } catch {}
      done(fallbackPositions());
    }, 30000);

    child.on('message', (msg) => {
      clearTimeout(timeout);
      if (msg && msg.positions) {
        done(msg.positions);
      } else {
        console.warn('[brain-graph] layout worker error:', msg?.error);
        done(fallbackPositions());
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.warn('[brain-graph] layout worker process error:', err?.message);
      done(fallbackPositions());
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        console.warn('[brain-graph] layout worker exited unexpectedly, code=' + code);
        done(fallbackPositions());
      }
    });

    // Send lightweight data (only id for nodes, source+target for edges)
    const lightNodes = nodes.map(n => ({ id: n.id }));
    const lightEdges = edges.map(e => ({ source: e.source, target: e.target }));
    child.send({ nodes: lightNodes, edges: lightEdges });
  });
}

// ─── Wikilink Injection ─────────────────────────────────────────

/**
 * For each customer node with group membership edges, update the .md file's
 * YAML frontmatter links field with [[Nhom: <groupName>]] entries.
 */
async function injectWikilinks(workspace, nodes, edges) {
  // Build group name lookup: groupNodeId -> label
  const groupLabels = new Map();
  for (const n of nodes) {
    if (n.type === 'group') groupLabels.set(n.id, n.label);
  }

  // Build customer -> group edges map
  const customerGroups = new Map(); // userNodeId -> [groupLabel, ...]
  for (const e of edges) {
    if (e.type !== 'membership') continue;
    const groupLabel = groupLabels.get(e.target);
    if (!groupLabel) continue;
    if (!customerGroups.has(e.source)) customerGroups.set(e.source, []);
    customerGroups.get(e.source).push(groupLabel);
  }

  let updated = 0;
  for (const [userNodeId, groupNames] of customerGroups) {
    const userId = userNodeId.replace('user:', '');
    const filePath = path.join(workspace, 'memory', 'zalo-users', userId + '.md');
    if (!fs.existsSync(filePath)) continue;

    const links = groupNames.map(name => '[[Nhóm: ' + name + ']]');

    try {
      await withMemoryFileLock(filePath, () => {
        let content;
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
        const newContent = updateFrontmatterLinks(content, links);
        if (newContent !== content) {
          fs.writeFileSync(filePath, newContent, 'utf-8');
          updated++;
        }
      });
    } catch (e) {
      console.warn('[brain-graph] wikilink injection failed for', userId, ':', e?.message);
    }
  }
  if (updated > 0) console.log('[brain-graph] injected wikilinks into', updated, 'customer files');
}

// ─── Obsidian Config ────────────────────────────────────────────

/**
 * If .obsidian/ doesn't exist in workspace, create it with graph.json
 * containing color groups for the node types.
 */
function ensureObsidianConfig(workspace) {
  const obsidianDir = path.join(workspace, '.obsidian');
  if (fs.existsSync(obsidianDir)) {
    console.log('[brain-graph] existing Obsidian config preserved');
    return;
  }

  try {
    fs.mkdirSync(obsidianDir, { recursive: true });
    const graphConfig = {
      collapse: { search: false, attachments: false, tag: false },
      search: '',
      showTags: false,
      showAttachments: false,
      showOrphans: true,
      colorGroups: [
        { query: 'path:memory/zalo-users', color: { a: 1, rgb: 15454984 } },   // yellow #eab308
        { query: 'path:memory/zalo-groups', color: { a: 1, rgb: 8490232 } },    // blue #818cf8
        { query: 'path:knowledge', color: { a: 1, rgb: 16282993 } },            // red #f87171
        { query: 'path:.learnings', color: { a: 1, rgb: 9741240 } },            // gray #94a3b8
      ],
    };
    fs.writeFileSync(path.join(obsidianDir, 'graph.json'), JSON.stringify(graphConfig), 'utf-8');
    console.log('[brain-graph] created .obsidian/graph.json');
  } catch (e) {
    console.warn('[brain-graph] Obsidian config creation failed:', e?.message);
  }
}

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Build the brain graph: collect nodes, edges, run layout, inject wikilinks,
 * write brain-graph.json. Returns the graph object.
 */
async function buildBrainGraph(workspace) {
  const ws = workspace || getWorkspace();
  if (!ws) throw new Error('No workspace available');

  const t0 = Date.now();
  console.log('[brain-graph] build started');

  // 1. Collect all nodes
  const customerNodes = collectCustomerNodes(ws);
  const groupNodes = collectGroupNodes(ws);
  const docNodes = collectDocNodes(ws);
  const learningNodes = collectLearningNodes(ws);
  const skillNodes = collectSkillNodes(ws);
  const allNodes = [...customerNodes, ...groupNodes, ...docNodes, ...learningNodes, ...skillNodes];

  // 2. Collect all edges (structural + semantic)
  const membershipEdges = collectMembershipEdges(customerNodes, ws);
  const productLearningEdges = collectProductLearningEdges(docNodes, learningNodes, ws);
  const escalationEdges = collectEscalationEdges(ws);
  const wikilinkEdges = collectWikilinkEdges(customerNodes, groupNodes, ws);
  const coMemberEdges = collectCoMembershipEdges(membershipEdges);
  const knowledgeEdges = collectKnowledgeSemanticEdges(customerNodes, docNodes, ws);

  const nodeIdSet = new Set(allNodes.map(n => n.id));
  const validEscalationEdges = escalationEdges.filter(e => nodeIdSet.has(e.source));

  const allEdges = [...membershipEdges, ...productLearningEdges, ...validEscalationEdges, ...wikilinkEdges, ...coMemberEdges, ...knowledgeEdges];
  // Dedup: same source→target pair keeps highest weight
  const edgeKey = (e) => e.source + '|' + e.target;
  const edgeMap = new Map();
  for (const e of allEdges) {
    const k = edgeKey(e);
    const existing = edgeMap.get(k);
    if (!existing || e.weight > existing.weight) edgeMap.set(k, e);
  }
  const dedupedEdges = [...edgeMap.values()];

  console.log('[brain-graph] collected', allNodes.length, 'nodes,', dedupedEdges.length, 'edges (deduped from', allEdges.length, ')');

  // 3. Run layout in child process
  const positions = await runLayout(allNodes, dedupedEdges);

  // 4. Merge positions into nodes
  for (const node of allNodes) {
    const pos = positions[node.id];
    if (pos) {
      node.x = Math.round(pos.x * 10) / 10;
      node.y = Math.round(pos.y * 10) / 10;
    } else {
      node.x = Math.round(Math.random() * 1000 * 10) / 10;
      node.y = Math.round(Math.random() * 1000 * 10) / 10;
    }
  }

  // 5. Build output JSON
  const graph = {
    version: 1,
    generatedAt: new Date().toISOString(),
    stats: { nodes: allNodes.length, edges: dedupedEdges.length },
    nodes: allNodes,
    edges: dedupedEdges,
  };

  // 6. Write compact JSON (no pretty-print)
  const outputPath = getBrainGraphPath(ws);
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch {}
  fs.writeFileSync(outputPath, JSON.stringify(graph), 'utf-8');

  const elapsed = Date.now() - t0;
  console.log('[brain-graph] build complete:', allNodes.length, 'nodes,', dedupedEdges.length, 'edges in', elapsed + 'ms →', outputPath);

  // 7. Wikilink injection (async, after graph build)
  try {
    await injectWikilinks(ws, allNodes, dedupedEdges);
  } catch (e) {
    console.warn('[brain-graph] wikilink injection pass failed:', e?.message);
  }

  // 8. Obsidian vault config (idempotent)
  try {
    ensureObsidianConfig(ws);
  } catch (e) {
    console.warn('[brain-graph] Obsidian config failed:', e?.message);
  }

  return graph;
}

module.exports = {
  buildBrainGraph,
  getBrainGraphPath,
  collectCustomerNodes,
  collectGroupNodes,
  collectDocNodes,
  collectLearningNodes,
  collectSkillNodes,
  collectMembershipEdges,
  collectProductLearningEdges,
  collectEscalationEdges,
  collectWikilinkEdges,
  collectCoMembershipEdges,
  collectKnowledgeSemanticEdges,
  // Internal helpers exported for testing
  parseFrontmatter,
  updateFrontmatterLinks,
};
