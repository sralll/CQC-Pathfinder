// Graph — port of com.watabou.geom.Graph.
// aStar is ported verbatim: it is actually Dijkstra with a FIFO openSet
// (Array.shift, no priority queue, no heuristic) — keep it exactly as-is.

// Haxe Array.remove(x) removes the first occurrence of x, if present.
function arrayRemove(a, value) {
	const index = a.indexOf(value);
	if (index === -1)
		return false;
	a.splice(index, 1);
	return true;
}

export class Node {
	constructor() {
		this.links = new Map();
	}

	link(node, price = 1, symmetrical = true) {
		this.links.set(node, price);
		if (symmetrical) {
			node.links.set(this, price);
		}
	}

	unlink(node, symmetrical = true) {
		this.links.delete(node);
		if (symmetrical) {
			node.links.delete(this);
		}
	}

	unlinkAll() {
		for (const node of this.links.keys()) {
			this.unlink(node);
		}
	}
}

export class Graph {
	constructor() {
		this.nodes = [];
	}

	add(node = null) {
		if (node === null) {
			node = new Node();
		}
		this.nodes.push(node);
		return node;
	}

	remove(node) {
		node.unlinkAll();
		arrayRemove(this.nodes, node);
	}

	aStar(start, goal, exclude = null) {
		const closedSet = exclude !== null ? exclude.slice() : [];
		const openSet = [start];
		const cameFrom = new Map();

		const gScore = new Map();
		gScore.set(start, 0);

		while (openSet.length > 0) {
			const current = openSet.shift();
			if (current === goal)
				return this.buildPath(cameFrom, current);

			arrayRemove(openSet, current);
			closedSet.push(current);

			const curScore = gScore.get(current);
			for (const neighbour of current.links.keys()) {
				if (closedSet.indexOf(neighbour) !== -1)
					continue;

				const score = curScore + current.links.get(neighbour);
				if (openSet.indexOf(neighbour) === -1)
					openSet.push(neighbour);
				else if (score >= gScore.get(neighbour))
					continue;

				cameFrom.set(neighbour, current);
				gScore.set(neighbour, score);
			}
		}

		return null;
	}

	buildPath(cameFrom, current) {
		const path = [current];

		while (cameFrom.has(current))
			path.push(current = cameFrom.get(current));

		return path;
	}

	calculatePrice(path) {
		if (path.length < 2) {
			return 0;
		}

		let price = 0.0;
		let current = path[0];
		let next = path[1];
		for (let i = 0; i < path.length - 1; i++) {
			if (current.links.has(next)) {
				price += current.links.get(next);
			} else {
				return NaN;
			}
			current = next;
			next = path[i + 1];
		}
		return price;
	}
}
