/**
 * brain-layout-worker.js — ForceAtlas2 graph layout in a child process.
 * Forked by brain-graph.js via child_process.fork().
 * Receives { nodes, edges }, returns { positions: { [id]: {x,y} } }.
 */
'use strict';

const { Graph } = require('graphology');
const forceAtlas2 = require('graphology-layout-forceatlas2');

process.on('message', (msg) => {
  try {
    const { nodes, edges } = msg;
    const graph = new Graph();

    for (const n of nodes) {
      graph.addNode(n.id, {
        x: Math.random() * 1000,
        y: Math.random() * 1000,
      });
    }

    for (const e of edges) {
      if (graph.hasNode(e.source) && graph.hasNode(e.target)) {
        graph.addEdge(e.source, e.target);
      }
    }

    forceAtlas2.assign(graph, {
      iterations: nodes.length > 2000 ? 100 : 200,
      settings: {
        barnesHutOptimize: true,
        scalingRatio: 2,
        gravity: 1,
      },
    });

    const positions = {};
    graph.forEachNode((id, attrs) => {
      positions[id] = { x: attrs.x, y: attrs.y };
    });

    process.send({ positions });
    process.exit(0);
  } catch (err) {
    process.send({ error: err.message || String(err) });
    process.exit(1);
  }
});
