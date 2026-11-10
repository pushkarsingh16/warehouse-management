import test from 'node:test';
import assert from 'node:assert/strict';
import { shortestPath, route } from '../src/routing.js';
const graph = { startNodeId: 'a', nodes: ['a', 'b', 'c'].map((id, x) => ({ id, position: { x, y: 0, z: 0 } })), edges: [{ from: 'a', to: 'b', distance: 1 }, { from: 'b', to: 'c', distance: 1 }, { from: 'a', to: 'c', distance: 10 }] };
test('routing respects aisles and picks the shortest available path', () => {
  assert.equal(shortestPath(graph, 'a', 'c').distance, 2);
  assert.deepEqual(route(graph, [{ aisleNodeId: 'c' }, { aisleNodeId: 'b' }]).stops.map(s => s.aisleNodeId), ['b', 'c']);
});
test('unreachable route is rejected', () => assert.throws(() => shortestPath({ ...graph, edges: [] }, 'a', 'c'), /unreachable/));
