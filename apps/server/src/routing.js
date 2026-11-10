export function shortestPath(graph, start, end) {
  const distances = new Map([[start, 0]]);
  const previous = new Map();
  const pending = new Set(graph.nodes.map(n => n.id));
  while (pending.size) {
    const current = [...pending].sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    if (!Number.isFinite(distances.get(current))) break;
    pending.delete(current);
    if (current === end) {
      const path = [end];
      while (previous.has(path[0])) path.unshift(previous.get(path[0]));
      return { distance: distances.get(end), coordinates: path.map(id => graph.nodes.find(n => n.id === id).position) };
    }
    for (const edge of graph.edges.filter(e => e.from === current || e.to === current)) {
      const next = edge.from === current ? edge.to : edge.from;
      const distance = distances.get(current) + edge.distance;
      if (distance < (distances.get(next) ?? Infinity)) { distances.set(next, distance); previous.set(next, current); }
    }
  }
  throw new Error('Warehouse aisle graph has an unreachable stop');
}
export function route(graph, bins) {
  let current = graph.startNodeId;
  const pending = [...new Map(bins.map(b => [b.aisleNodeId, b])).values()];
  const stops = [];
  while (pending.length) {
    const options = pending.map(bin => ({ bin, path: shortestPath(graph, current, bin.aisleNodeId) })).sort((a, b) => a.path.distance - b.path.distance);
    const next = options[0];
    stops.push({ aisleNodeId: next.bin.aisleNodeId, ...next.path });
    current = next.bin.aisleNodeId;
    pending.splice(pending.indexOf(next.bin), 1);
  }
  return { method: 'nearest-neighbor-dijkstra', stops };
}
