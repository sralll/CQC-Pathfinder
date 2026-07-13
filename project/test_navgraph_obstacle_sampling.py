from unittest import mock

import numpy as np
import scipy.ndimage as ndi
from django.test import SimpleTestCase

from project.navgraph import (
    CONTOUR_AREA_SPACING_PX,
    NavgraphBuildCancelled,
    _adaptive_lattice_nodes,
    _candidate_edges,
    _dedupe_appended_nodes,
    _filter_contours_near_centerline,
    _filter_points_near_visible_nodes,
    _visible_backbone_samples,
    _obstacle_offset_nodes,
    _prune_redundant_nodes,
    _sparsify_redundant_edges,
    _very_slow_offset_nodes,
    _weight_edges,
    build_navgraph,
)


class ObstacleBiasedSamplingTests(SimpleTestCase):
    def test_build_aborts_when_progress_owner_returns_false(self):
        with self.assertRaises(NavgraphBuildCancelled):
            build_navgraph(
                'mask-is-never-opened.png',
                progress_callback=lambda _progress: False,
            )

    def test_low_clearance_skeleton_gets_a_gate_anchor(self):
        clearance = np.full((31, 61), 40.0, dtype=np.float32)
        skeleton = np.zeros_like(clearance, dtype=bool)
        skeleton[15, 5:56] = True
        # A five-cell wall opening in the middle of an otherwise open route.
        clearance[15, 28:33] = 2.0

        protected, open_nodes, stats = _adaptive_lattice_nodes(
            clearance,
            skeleton,
            bottleneck_spacing=8,
            near_spacing=16,
            far_spacing=24,
            obstacle_clearance=6,
            near_clearance_max=20,
        )

        self.assertTrue(any(y == 15 and 28 <= x <= 32 for y, x in protected))
        self.assertGreater(stats["bottleneck_candidates"], 0)
        self.assertGreater(len(open_nodes), 0)

    def test_contour_sampling_offsets_both_sides_close_to_obstacle(self):
        mask = np.full((60, 80), 241, dtype=np.uint8)
        mask[20:40, 25:55] = 0
        clearance = ndi.distance_transform_edt(mask != 0).astype(np.float32)

        corners, samples, pairs, stats = _obstacle_offset_nodes(
            mask, clearance,
            simplify_px=2,
            min_length_px=12,
            min_turn_degrees=35,
            offset_px=2,
            sample_spacing_px=8,
        )

        self.assertGreaterEqual(len(corners), 4)
        self.assertGreater(len(corners) + len(samples), 0)
        self.assertGreater(len(pairs), 0)
        self.assertGreater(stats["area_suppressed_candidates"], 0)
        all_nodes = corners + samples
        # For a side shorter than the 32 px thinning radius, its two offset
        # corner anchors may cover the complete legal straight run.
        self.assertTrue(any(y < 20 and 23 <= x <= 56 for x, y in all_nodes))
        self.assertTrue(any(y >= 40 and 23 <= x <= 56 for x, y in all_nodes))
        self.assertTrue(all(1 <= clearance[y, x] <= 4 for x, y in all_nodes))

    def test_dense_sampling_is_spaced_but_opposite_wall_sides_survive(self):
        mask = np.full((70, 100), 241, dtype=np.uint8)
        mask[34:37, 15:85] = 0  # thin wall; opposite offsets are <10 px apart
        clearance = ndi.distance_transform_edt(mask != 0).astype(np.float32)

        protected, regular, _, stats = _obstacle_offset_nodes(
            mask, clearance,
            simplify_px=4,
            min_length_px=8,
            offset_px=2,
            sample_spacing_px=2,  # intentionally over-generate
        )

        nodes = protected + regular
        self.assertTrue(any(y < 34 for x, y in nodes))
        self.assertTrue(any(y >= 37 for x, y in nodes))
        self.assertGreater(stats["area_suppressed_candidates"], 0)
        # Same-run retained nodes respect the thinning target. Opposite-side
        # pairs may be closer because the black wall correctly prevents LOS.
        for i, (x, y) in enumerate(nodes):
            for xx, yy in nodes[i + 1:]:
                if ((x - xx) ** 2 + (y - yy) ** 2 >
                        CONTOUR_AREA_SPACING_PX ** 2):
                    continue
                steps = max(abs(x - xx), abs(y - yy))
                crosses_black = any(
                    mask[
                        int(round(y + (yy - y) * k / max(1, steps))),
                        int(round(x + (xx - x) * k / max(1, steps))),
                    ] == 0
                    for k in range(steps + 1)
                )
                self.assertTrue(crosses_black)

        # The 32 px LOS-aware pass is substantially more aggressive than raw
        # 2 px generation on each straight side.
        self.assertLess(len(nodes), 20)

    def test_wall_gap_gets_close_offset_nodes(self):
        mask = np.full((70, 80), 241, dtype=np.uint8)
        mask[:32, 40:44] = 0
        mask[38:, 40:44] = 0
        clearance = ndi.distance_transform_edt(mask != 0).astype(np.float32)

        corners, samples, _, _ = _obstacle_offset_nodes(
            mask, clearance,
            simplify_px=2,
            min_length_px=8,
            min_turn_degrees=30,
            offset_px=2,
            sample_spacing_px=12,
        )

        nodes = corners + samples
        self.assertTrue(any(31 <= y <= 39 and 37 <= x <= 46 for x, y in nodes))

    def test_tiny_compact_obstacle_skips_contour_but_thin_wall_does_not(self):
        compact = np.full((60, 80), 241, dtype=np.uint8)
        compact[25:35, 35:45] = 0
        compact_dist = ndi.distance_transform_edt(compact != 0).astype(np.float32)
        corners, regular, _, stats = _obstacle_offset_nodes(
            compact, compact_dist, min_length_px=8)
        self.assertEqual(corners + regular, [])
        self.assertEqual(stats["tiny_contours_skipped"], 1)

        wall = np.full((60, 80), 241, dtype=np.uint8)
        wall[29:32, 10:70] = 0
        wall_dist = ndi.distance_transform_edt(wall != 0).astype(np.float32)
        corners, regular, _, stats = _obstacle_offset_nodes(
            wall, wall_dist, min_length_px=8)
        self.assertGreater(len(corners) + len(regular), 0)
        self.assertEqual(stats["tiny_contours_skipped"], 0)

    def test_visible_centerline_removes_corridor_boundary_samples(self):
        mask = np.full((30, 60), 241, dtype=np.uint8)
        mask[:, :20] = 0
        mask[:, 40:] = 0
        corners = [(21, 5), (21, 25)]
        regular = [(22, 10), (22, 20)]
        centerline = [(30, 10), (30, 20)]
        # Slow outline samples are intentionally replaced by the preferred fast
        # centerline inside a proven narrow corridor.
        for x, y in corners + regular:
            mask[y, x] = 200

        kept_corners, kept_regular, _, removed = (
            _filter_contours_near_centerline(
                mask, corners, regular, [], centerline, radius=12))

        self.assertEqual(kept_corners, [])
        self.assertEqual(kept_regular, [])
        self.assertEqual(removed, 4)

    def test_centerline_filter_keeps_point_without_direct_los(self):
        mask = np.full((20, 30), 241, dtype=np.uint8)
        mask[:, 14] = 0
        kept, removed = _filter_points_near_visible_nodes(
            mask, [(12, 10)], [(16, 10)], radius=12)
        self.assertEqual(kept, [(12, 10)])
        self.assertEqual(removed, 0)

    def test_slower_centerline_cannot_replace_fast_path_node(self):
        mask = np.full((20, 30), 241, dtype=np.uint8)
        mask[10, 12] = 243
        kept, removed = _filter_points_near_visible_nodes(
            mask, [(12, 10)], [(16, 10)], radius=12)
        self.assertEqual(kept, [(12, 10)])
        self.assertEqual(removed, 0)

        mask[10, 16] = 243
        kept, removed = _filter_points_near_visible_nodes(
            mask, [(12, 10)], [(16, 10)], radius=12)
        self.assertEqual(kept, [])
        self.assertEqual(removed, 1)

    def test_narrow_backbone_gets_small_reversible_local_budget(self):
        nodes = [(10, 10), (20, 10), (30, 10), (40, 10)]
        backbone = [(0, 1, 10.0), (1, 2, 10.0), (2, 3, 10.0)]
        edges = _candidate_edges(
            nodes, backbone, backbone_only_nodes=set(range(4)))
        self.assertTrue({(0, 1), (1, 2), (2, 3)}.issubset(edges))
        # The reduced budget may add a direct local alternative, but remains
        # far below a dense unrestricted visibility graph.
        self.assertLessEqual(len(edges), 6)

    def test_sparse_visible_pair_beyond_old_120px_cap_is_connected(self):
        mask = np.full((40, 220), 241, dtype=np.uint8)
        nodes = [(10, 20), (190, 20)]

        edges = _candidate_edges(nodes, [], mask=mask)

        self.assertIn((0, 1), edges)

    def test_candidate_progress_counts_every_processed_node(self):
        mask = np.full((40, 80), 241, dtype=np.uint8)
        nodes = [(10, 20), (30, 20), (50, 20), (70, 20)]
        updates = []

        _candidate_edges(
            nodes, [], mask=mask,
            progress_callback=lambda current, total: updates.append(
                (current, total)))

        self.assertEqual(updates[0], (0, len(nodes)))
        self.assertEqual(updates[-1], (len(nodes), len(nodes)))
        self.assertTrue(all(total == len(nodes) for _, total in updates))

    def test_small_black_interruption_is_a_bounded_detour_candidate(self):
        mask = np.full((40, 120), 241, dtype=np.uint8)
        mask[20, 58:61] = 0
        nodes = [(20, 20), (100, 20)]

        edges, detours = _candidate_edges(
            nodes, [], mask=mask, return_local_detours=True)

        self.assertIn((0, 1), edges)
        self.assertIn((0, 1), detours)
        kept, _ = _weight_edges(mask, nodes, edges, set(), detours)
        self.assertIn((0, 1), kept)

    def test_weighting_reuses_candidate_line_measurement(self):
        mask = np.full((40, 120), 241, dtype=np.uint8)
        nodes = [(20, 20), (100, 20)]
        edges, detours, line_results = _candidate_edges(
            nodes, [], mask=mask, return_local_detours=True,
            return_line_results=True)

        with mock.patch(
                'project.navgraph._line_cost_batch',
                side_effect=AssertionError('LOS was measured twice')):
            kept, _ = _weight_edges(
                mask, nodes, edges, set(), detours, line_results)

        self.assertEqual(kept, [(0, 1)])

    def test_wide_black_obstacle_is_not_a_local_detour_candidate(self):
        mask = np.full((50, 140), 241, dtype=np.uint8)
        mask[:, 55:80] = 0
        nodes = [(20, 25), (120, 25)]

        edges, detours = _candidate_edges(
            nodes, [], mask=mask, return_local_detours=True)

        self.assertNotIn((0, 1), edges)
        self.assertNotIn((0, 1), detours)

    def test_edge_spanner_removes_only_near_equal_two_hop_edge(self):
        edges = np.asarray([(0, 1), (0, 2), (2, 1)], dtype=np.int32)

        kept_edges, _, _, removed = _sparsify_redundant_edges(
            edges, np.asarray([10.0, 5.0, 5.0], dtype=np.float32))
        self.assertEqual(removed, 1)
        self.assertNotIn((0, 1), set(map(tuple, kept_edges)))

        kept_edges, _, _, removed = _sparsify_redundant_edges(
            edges, np.asarray([10.0, 5.1, 5.1], dtype=np.float32))
        self.assertEqual(removed, 0)
        self.assertIn((0, 1), set(map(tuple, kept_edges)))

    def test_edge_spanner_never_removes_protected_typed_edge(self):
        edges = np.asarray([(0, 1), (0, 2), (2, 1)], dtype=np.int32)
        protected = np.asarray([True, False, False])

        kept_edges, _, _, removed = _sparsify_redundant_edges(
            edges, np.asarray([10.0, 5.0, 5.0], dtype=np.float32), protected)

        self.assertEqual(removed, 0)
        self.assertIn((0, 1), set(map(tuple, kept_edges)))

    def test_typed_edges_cannot_witness_removal_of_base_edge(self):
        edges = np.asarray([(0, 1), (0, 2), (2, 1)], dtype=np.int32)
        typed = np.asarray([False, True, True])

        kept_edges, _, _, removed = _sparsify_redundant_edges(
            edges, np.asarray([10.0, 5.0, 5.0], dtype=np.float32), typed)

        self.assertEqual(removed, 0)
        self.assertIn((0, 1), set(map(tuple, kept_edges)))

    def test_dense_backbone_samples_cover_between_sparse_endpoints(self):
        mask = np.full((30, 80), 241, dtype=np.uint8)
        skeleton = [(10, 15), (70, 15)]
        samples = _visible_backbone_samples(
            mask, skeleton, [(0, 1, 60.0)], spacing=8)
        self.assertTrue(any(36 <= x <= 44 and y == 15 for x, y in samples))

        kept, removed = _filter_points_near_visible_nodes(
            mask, [(40, 5)], samples, radius=12)
        self.assertEqual(kept, [])
        self.assertEqual(removed, 1)

    def test_noisy_u_shape_keeps_inner_arms_bottom_and_adjacency(self):
        mask = np.full((70, 90), 241, dtype=np.uint8)
        mask[15:55, 20:70] = 0
        mask[12:42, 35:55] = 241  # north-facing cut-out: wide U
        # Pixel-scale perturbations must not erase the simplified inner sides.
        mask[24, 34] = 241
        mask[29, 35] = 0
        mask[31, 54] = 0
        mask[36, 55] = 241
        clearance = ndi.distance_transform_edt(mask != 0).astype(np.float32)

        protected, regular, pairs, stats = _obstacle_offset_nodes(
            mask, clearance,
            simplify_px=8,
            min_length_px=8,
            min_turn_degrees=40,
            offset_px=2,
            sample_spacing_px=24,
        )

        nodes = protected + regular
        self.assertTrue(any(35 <= x <= 38 and 17 <= y <= 40 for x, y in protected))
        self.assertTrue(any(52 <= x <= 55 and 17 <= y <= 40 for x, y in protected))
        self.assertTrue(any(37 <= x <= 53 and 39 <= y <= 43 for x, y in protected))
        self.assertGreater(stats["segment_anchors"], 0)
        self.assertTrue(any(
            34 <= nodes[a][0] <= 56 and 34 <= nodes[b][0] <= 56 and
            12 <= nodes[a][1] <= 44 and 12 <= nodes[b][1] <= 44
            for a, b in pairs
        ))

    def test_very_slow_contours_place_outside_without_entering_black(self):
        mask = np.full((70, 90), 241, dtype=np.uint8)
        mask[20:50, 25:60] = 135
        mask[15:20, 25:60] = 0  # black directly against the north side

        protected, regular, pairs, stats = _very_slow_offset_nodes(mask)

        nodes = protected + regular
        self.assertGreater(len(nodes), 0)
        self.assertTrue(all(mask[y, x] not in (0, 135) for x, y in nodes))
        self.assertTrue(any(x < 25 for x, y in nodes))
        self.assertTrue(any(x >= 60 for x, y in nodes))
        self.assertGreater(len(pairs), 0)
        self.assertEqual(stats["boundary_value"], 135)

    def test_deduplication_does_not_cross_a_thin_wall(self):
        mask = np.full((20, 20), 241, dtype=np.uint8)
        mask[:, 10] = 0
        nodes = [(9, 10), (11, 10)]

        deduped, _, _ = _dedupe_appended_nodes(mask, nodes, 0, min_distance=6)

        self.assertEqual(deduped, nodes)

    def test_deduplication_merges_visible_same_terrain_candidates(self):
        mask = np.full((20, 20), 241, dtype=np.uint8)
        nodes = [(5, 10), (8, 10)]

        deduped, source_indices, source_to_output = _dedupe_appended_nodes(
            mask, nodes, 0, min_distance=6)

        self.assertEqual(deduped, [nodes[0]])
        self.assertEqual(source_indices, [0])
        self.assertEqual(source_to_output, [0, 0])

    def test_deduplication_preserves_nearby_different_terrain(self):
        mask = np.full((20, 20), 135, dtype=np.uint8)
        mask[:, :7] = 243
        nodes = [(5, 10), (8, 10)]

        deduped, _, _ = _dedupe_appended_nodes(mask, nodes, 0, min_distance=6)

        self.assertEqual(deduped, nodes)

    def test_deduplication_preserves_thinned_boundary_coverage_anchor(self):
        mask = np.full((20, 20), 241, dtype=np.uint8)
        # The first node represents the fixed skeleton.  The second is already
        # contour-thinned and must not be replaced just because it is visible
        # and within the ordinary global dedupe radius.
        nodes = [(10, 10), (12, 10)]

        deduped, source_indices, source_to_output = _dedupe_appended_nodes(
            mask, nodes, fixed_count=1, min_distance=10,
            protected_source_end=2)

        self.assertEqual(deduped, nodes)
        self.assertEqual(source_indices, [0, 1])
        self.assertEqual(source_to_output, [0, 1])

    def test_obstacle_nodes_consider_more_edge_candidates(self):
        nodes = [(50, 50)]
        for i in range(12):
            angle = 2.0 * np.pi * i / 12.0
            nodes.append((
                int(round(50 + 30 * np.cos(angle))),
                int(round(50 + 30 * np.sin(angle))),
            ))

        mask = np.full((101, 101), 241, dtype=np.uint8)
        edges = _candidate_edges(nodes, [], feature_nodes={0}, mask=mask)
        incident = {b if a == 0 else a for a, b in edges if a == 0 or b == 0}

        self.assertGreaterEqual(len(incident), 7)
        self.assertLessEqual(len(incident), 12)

    def test_witness_pruning_removes_only_redundant_open_node(self):
        nodes = [(10, 10), (10, 5), (15, 10), (10, 15), (5, 10)]
        edges = [(0, 1), (0, 2), (0, 3), (0, 4)]
        edges.extend((i, j) for i in range(1, 5) for j in range(i + 1, 5))
        weights = [1.0] * 4 + [1.5] * 6
        components = np.ones(5, dtype=np.int32)

        pruned_nodes, _, _, _, removed = _prune_redundant_nodes(
            nodes, edges, weights, components, protected_nodes={1, 2, 3, 4})

        self.assertEqual(removed, 1)
        self.assertNotIn((10, 10), pruned_nodes)

        kept_nodes, _, _, _, protected_removed = _prune_redundant_nodes(
            nodes, edges, weights, components, protected_nodes=set(range(5)))
        self.assertEqual(protected_removed, 0)
        self.assertEqual(kept_nodes, nodes)
