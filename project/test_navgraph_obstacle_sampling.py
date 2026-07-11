import numpy as np
from django.test import SimpleTestCase

from project.navgraph import (
    _adaptive_lattice_nodes,
    _candidate_edges,
    _dedupe_appended_nodes,
)


class ObstacleBiasedSamplingTests(SimpleTestCase):
    def test_low_clearance_skeleton_gets_a_gate_anchor(self):
        clearance = np.full((31, 61), 40.0, dtype=np.float32)
        skeleton = np.zeros_like(clearance, dtype=bool)
        skeleton[15, 5:56] = True
        # A five-cell wall opening in the middle of an otherwise open route.
        clearance[15, 28:33] = 2.0

        nodes, stats = _adaptive_lattice_nodes(
            clearance,
            skeleton,
            obstacle_spacing=6,
            bottleneck_spacing=8,
            near_spacing=16,
            far_spacing=24,
            obstacle_clearance=6,
            near_clearance_max=20,
        )

        obstacle_nodes = nodes[:stats["obstacle_candidate_count"]]
        self.assertTrue(any(y == 15 and 28 <= x <= 32 for y, x in obstacle_nodes))
        self.assertGreater(stats["bottleneck_candidates"], 0)

    def test_deduplication_does_not_cross_a_thin_wall(self):
        mask = np.full((20, 20), 241, dtype=np.uint8)
        mask[:, 10] = 0
        nodes = [(9, 10), (11, 10)]

        deduped, _ = _dedupe_appended_nodes(mask, nodes, 0, min_distance=6)

        self.assertEqual(deduped, nodes)

    def test_deduplication_merges_visible_same_terrain_candidates(self):
        mask = np.full((20, 20), 241, dtype=np.uint8)
        nodes = [(5, 10), (8, 10)]

        deduped, source_indices = _dedupe_appended_nodes(
            mask, nodes, 0, min_distance=6)

        self.assertEqual(deduped, [nodes[0]])
        self.assertEqual(source_indices, [0])

    def test_deduplication_preserves_nearby_different_terrain(self):
        mask = np.full((20, 20), 135, dtype=np.uint8)
        mask[:, :7] = 243
        nodes = [(5, 10), (8, 10)]

        deduped, _ = _dedupe_appended_nodes(mask, nodes, 0, min_distance=6)

        self.assertEqual(deduped, nodes)

    def test_obstacle_nodes_consider_more_edge_candidates(self):
        nodes = [(50, 50)]
        for i in range(12):
            angle = 2.0 * np.pi * i / 12.0
            nodes.append((
                int(round(50 + 30 * np.cos(angle))),
                int(round(50 + 30 * np.sin(angle))),
            ))

        edges = _candidate_edges(nodes, [], obstacle_nodes={0})
        incident = {b if a == 0 else a for a, b in edges if a == 0 or b == 0}

        self.assertEqual(len(incident), 12)
