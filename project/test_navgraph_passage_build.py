"""CR 8.2 passage construction and projected-base isolation tests."""

import tempfile
from pathlib import Path

import numpy as np
from django.test import SimpleTestCase
from PIL import Image

from project import navgraph as ng


PASSAGE_ID = "8cb8a384-c073-4a4d-9dce-b67e2c6de101"


def _document(points=None, width=20):
    return {"version": 1, "items": [{
        "id": PASSAGE_ID,
        "points": points or [[150, 50], [150, 110], [150, 170]],
        "width": width,
    }]}


def _base_artifact(nodes, edges, components=None, height=220, width=300):
    return {
        "version": ng.NAVGRAPH_VERSION,
        "nodes": np.asarray(nodes, dtype=np.int32),
        "edges": np.asarray(edges, dtype=np.int32).reshape(-1, 2),
        "weights": np.asarray([
            np.hypot(nodes[v][0] - nodes[u][0], nodes[v][1] - nodes[u][1]) * 14
            for u, v in edges
        ], dtype=np.float32),
        "components": np.asarray(components or [1] * len(nodes), dtype=np.int32),
        "min_cost_per_px": np.float32(14),
        "mask_shape": np.asarray([height, width], dtype=np.int32),
        "coarse_scale": np.int32(4),
        "coarse_minval": np.full((1, 2), 241, dtype=np.uint8),
        "coarse_clear": np.full((1, 2), 20, dtype=np.uint8),
        "coarse_labels": np.asarray([[1, 2]], dtype=np.int32),
        "hitzone_scale": np.int32(16),
        "coarse_hitzone": np.ones((1, 2), dtype=np.uint8),
        "stats": {},
    }


def _adjacency(artifact, kind=None):
    adjacency = [[] for _ in artifact["nodes"]]
    for index, (u, v) in enumerate(artifact["edges"]):
        if kind is None or int(artifact["edge_kinds"][index]) == kind:
            adjacency[int(u)].append(int(v))
            adjacency[int(v)].append(int(u))
    return adjacency


def _reachable(adjacency, source, target):
    stack, seen = [source], {source}
    while stack:
        node = stack.pop()
        if node == target:
            return True
        for neighbour in adjacency[node]:
            if neighbour not in seen:
                seen.add(neighbour)
                stack.append(neighbour)
    return False


class PassageBuildGeometryTests(SimpleTestCase):
    def test_consecutive_duplicates_removed_and_frames_match_runtime(self):
        _, passages = ng._normalize_passages_for_build(
            _document([[150, 50], [150, 50], [150, 170]]), 300, 220)
        self.assertEqual(passages[0]["points"], [(150.0, 50.0), (150.0, 170.0)])
        self.assertEqual(passages[0]["frames"]["start_outer"], (150.0, 47.0))
        self.assertEqual(passages[0]["frames"]["end_outer"], (150.0, 173.0))

    def test_out_of_bounds_and_self_overlap_abort_whole_build(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            ng._normalize_passages_for_build(_document([[-1, 50], [150, 170]]), 300, 220)
        with self.assertRaisesRegex(ValueError, "self-overlapping"):
            ng._normalize_passages_for_build(
                _document([[50, 50], [250, 50], [250, 150], [50, 50]], width=20),
                300, 220)

    def test_body_has_flat_caps_and_round_interior_join(self):
        _, passages = ng._normalize_passages_for_build(
            _document([[100, 100], [150, 100], [150, 150]], width=20), 300, 220)
        passage = passages[0]
        self.assertTrue(ng._point_in_passage_body(passage, 145, 105))
        self.assertFalse(ng._point_in_passage_body(passage, 99, 100))
        self.assertFalse(ng._point_in_passage_body(passage, 150, 151))

    def test_bent_arm_behind_terminal_plane_remains_in_body(self):
        _, passages = ng._normalize_passages_for_build(_document(
            [[100, 100], [180, 100], [180, 180], [40, 180]], width=20), 300, 220)
        self.assertTrue(ng._point_in_passage_body(passages[0], 80, 180))

    def test_multi_hit_edge_must_be_transverse_at_every_local_tangent(self):
        _, passages = ng._normalize_passages_for_build(_document(
            [[100, 50], [100, 150], [200, 150]], width=30), 300, 220)
        relation = ng._edge_passage_relation((50, 100), (230, 160), passages[0])
        self.assertIsNotNone(relation)
        self.assertFalse(relation[0])

    def test_concave_polygon_detects_subpixel_excursion(self):
        polygon = [(0, 0), (10, 0), (10, 10), (5.1, 10),
                   (5.1, 4), (4.9, 4), (4.9, 10), (0, 10)]
        self.assertFalse(ng._segment_in_polygon((4, 5), (6, 5), polygon))

    def test_region_filter_omits_whole_outside_passages(self):
        inside_id = "0aaa1111-2222-3333-4444-555566667777"
        outside_id = PASSAGE_ID
        document = {"version": 1, "items": [
            {"id": inside_id, "points": [[40, 40], [80, 80]], "width": 20},
            {"id": outside_id, "points": [[180, 40], [220, 80]], "width": 20},
        ]}
        effective, ignored = ng.filter_level_passages_for_region(
            document, [(0, 0), (120, 0), (120, 120), (0, 120)], 300, 220)

        self.assertEqual([item["id"] for item in effective["items"]], [inside_id])
        self.assertEqual(ignored, [outside_id])


class PassageTopologyTests(SimpleTestCase):
    def setUp(self):
        self.mask = np.full((220, 300), 241, dtype=np.uint8)
        self.nodes = [
            (50, 110), (250, 110),       # real transverse underpass
            (150, 30), (150, 80),        # projected longitudinal base route
            (150, 140), (150, 190),
        ]
        self.edges = [(0, 1), (2, 3), (3, 4), (4, 5)]

    def _build(self, components=None):
        document = _document()
        canonical, passages = ng._normalize_passages_for_build(document, 300, 220)
        artifact = _base_artifact(self.nodes, self.edges, components=components)
        stats = ng._apply_passage_topology(
            artifact, self.mask, passages, canonical,
            region_polygon=[(0, 0), (299, 0), (299, 219), (0, 219)])
        return artifact, stats

    def test_false_junction_isolated_and_chain_protected(self):
        artifact, stats = self._build()
        base_count = int(artifact["base_node_count"])
        start = int(artifact["passage_node_start"][0])
        count = int(artifact["passage_node_count"][0])
        end = start + count - 1

        # Shadow nodes at y=80/140 are removed, while the transverse underpass
        # remains a base edge and the passage chain is continuous.
        self.assertEqual(stats["base_nodes_shadowed_by_passages"], [2])
        base_adj = _adjacency(artifact, ng.EDGE_KIND_BASE)
        self.assertTrue(_reachable(base_adj, 0, 1))
        passage_adj = _adjacency(artifact, ng.EDGE_KIND_PASSAGE)
        self.assertTrue(_reachable(passage_adj, start, end))
        self.assertTrue(_reachable(passage_adj, end, start))

        # Exactly consecutive same-passage edges; the middle node has degree 2
        # and no transition or generic base edge can touch it.
        middle = start + 1
        self.assertEqual(sorted(passage_adj[middle]), [start, end])
        for edge, kind in zip(artifact["edges"], artifact["edge_kinds"]):
            if middle in edge:
                self.assertEqual(int(kind), ng.EDGE_KIND_PASSAGE)
        transitions = [tuple(map(int, edge)) for edge, kind in
                       zip(artifact["edges"], artifact["edge_kinds"])
                       if int(kind) == ng.EDGE_KIND_TRANSITION]
        self.assertTrue(transitions)
        self.assertTrue(all(start in edge or end in edge for edge in transitions))
        self.assertGreaterEqual(sum(start in edge for edge in transitions), 1)
        self.assertGreaterEqual(sum(end in edge for edge in transitions), 1)

    def test_passage_chain_unions_base_components_for_prefilter(self):
        artifact, _ = self._build(components=[1, 2, 1, 1, 2, 2])
        self.assertEqual(int(artifact["components"][0]), int(artifact["components"][1]))
        self.assertEqual(int(artifact["coarse_labels"][0, 0]),
                         int(artifact["coarse_labels"][0, 1]))

    def test_two_point_passage_has_one_bidirectional_chain_edge(self):
        document = _document([[150, 50], [150, 170]])
        canonical, passages = ng._normalize_passages_for_build(document, 300, 220)
        artifact = _base_artifact(self.nodes, self.edges)
        ng._apply_passage_topology(artifact, self.mask, passages, canonical)
        passage_edges = [edge for edge, kind in zip(artifact["edges"], artifact["edge_kinds"])
                         if int(kind) == ng.EDGE_KIND_PASSAGE]
        self.assertEqual(len(passage_edges), 1)

    def test_connector_cannot_cross_another_passage_body(self):
        document = {"version": 1, "items": [
            {"id": "0aaa1111-2222-3333-4444-555566667777",
             "points": [[150, 100], [150, 170]], "width": 20},
            {"id": "8cb8a384-c073-4a4d-9dce-b67e2c6de101",
             "points": [[100, 60], [200, 60]], "width": 20},
        ]}
        canonical, passages = ng._normalize_passages_for_build(document, 300, 220)
        artifact = _base_artifact([(150, 30), (150, 200)], [(0, 1)])
        with self.assertRaisesRegex(ValueError, "start endpoint has no legal base connector"):
            ng._apply_passage_topology(artifact, self.mask, passages, canonical)

    def test_fractional_endpoint_uses_adjacent_legal_raster_representative(self):
        document = _document([[150.51, 50.2], [150, 170]], width=20)
        canonical, passages = ng._normalize_passages_for_build(document, 300, 220)
        mask = self.mask.copy()
        mask[50, 151] = ng.IMPASSABLE
        artifact = _base_artifact([(150, 30), (150, 190)], [(0, 1)])

        stats = ng._apply_passage_topology(
            artifact, mask, passages, canonical,
            region_polygon=[(0, 0), (299, 0), (299, 219), (0, 219)])

        start = int(artifact["passage_node_start"][0])
        self.assertEqual(tuple(artifact["nodes"][start]), (150, 50))
        self.assertEqual(stats["passage_endpoint_graph_adjustments"], [{
            "id": PASSAGE_ID,
            "endpoint": "start",
            "from": (151, 50),
            "to": (150, 50),
        }])

    def test_passages_may_share_base_transition_at_overlapping_entrances(self):
        low = "0aaa1111-2222-3333-4444-555566667777"
        document = {"version": 1, "items": [
            {"id": low, "points": [[150, 100], [150, 170]], "width": 20},
            {"id": PASSAGE_ID, "points": [[150, 100], [230, 100]], "width": 20},
        ]}
        canonical, passages = ng._normalize_passages_for_build(document, 300, 220)
        artifact = _base_artifact(
            [(150, 70), (150, 200), (120, 100), (260, 100)], [])

        ng._apply_passage_topology(
            artifact, self.mask, passages, canonical,
            region_polygon=[(0, 0), (299, 0), (299, 219), (0, 219)])

        first_start = int(artifact["passage_node_start"][0])
        second_start = int(artifact["passage_node_start"][1])
        self.assertNotEqual(first_start, second_start)
        self.assertEqual(tuple(artifact["nodes"][first_start]), (150, 100))
        self.assertEqual(tuple(artifact["nodes"][second_start]), (150, 100))
        self.assertFalse(any(
            set(map(int, edge)) == {first_start, second_start}
            for edge in artifact["edges"]
        ))

    def test_passages_are_appended_in_canonical_id_order(self):
        high = PASSAGE_ID
        low = "0aaa1111-2222-3333-4444-555566667777"
        document = {"version": 1, "items": [
            {"id": high, "points": [[200, 50], [200, 170]], "width": 20},
            {"id": low, "points": [[100, 50], [100, 170]], "width": 20},
        ]}
        _, passages = ng._normalize_passages_for_build(document, 300, 220)
        self.assertEqual([passage["id"] for passage in passages], [low, high])

    def test_overlapping_passage_chains_keep_coincident_nodes_independent(self):
        document = {"version": 1, "items": [
            {"id": "0aaa1111-2222-3333-4444-555566667777",
             "points": [[150, 50], [150, 110], [150, 170]], "width": 20},
            {"id": PASSAGE_ID,
             "points": [[70, 110], [150, 110], [230, 110]], "width": 20},
        ]}
        canonical, passages = ng._normalize_passages_for_build(document, 300, 220)
        artifact = _base_artifact(
            [(150, 30), (150, 190), (50, 110), (250, 110)], [])
        ng._apply_passage_topology(artifact, self.mask, passages, canonical)
        first_middle = int(artifact["passage_node_start"][0]) + 1
        second_middle = int(artifact["passage_node_start"][1]) + 1
        self.assertNotEqual(first_middle, second_middle)
        self.assertEqual(tuple(artifact["nodes"][first_middle]),
                         tuple(artifact["nodes"][second_middle]))
        for edge, kind, owner in zip(
                artifact["edges"], artifact["edge_kinds"], artifact["edge_passage"]):
            if int(kind) == ng.EDGE_KIND_PASSAGE:
                start = int(artifact["passage_node_start"][int(owner)])
                count = int(artifact["passage_node_count"][int(owner)])
                self.assertTrue(all(start <= int(node) < start + count for node in edge))

    def test_public_builder_accepts_canonical_document(self):
        # A small smoke test proves the public signature wires normalization and
        # typed construction into a real skeleton/lattice build.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "mask.png")
            Image.fromarray(self.mask).save(path)
            artifact = ng.build_navgraph(
                str(path),
                region_polygon=[(0, 0), (299, 0), (299, 219), (0, 219)],
                level_passages=_document([[130, 109], [170, 109]]))
        self.assertEqual(int(artifact["base_node_count"]),
                         len(artifact["nodes"]) - 2)
        self.assertEqual(list(artifact["edge_kinds"]).count(ng.EDGE_KIND_PASSAGE), 1)

    def test_public_builder_ignores_passage_outside_region(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "mask.png")
            Image.fromarray(self.mask).save(path)
            artifact = ng.build_navgraph(
                str(path),
                region_polygon=[(0, 0), (120, 0), (120, 219), (0, 219)],
                level_passages=_document([[200, 50], [200, 170]]))

        self.assertEqual(int(artifact["base_node_count"]), len(artifact["nodes"]))
        self.assertEqual(artifact["stats"]["n_passages"], 0)
        self.assertEqual(artifact["stats"]["ignored_passages_outside_region"], 1)
        self.assertEqual(
            artifact["stats"]["ignored_passage_ids_outside_region"], [PASSAGE_ID])

    def test_empty_document_preserves_base_topology(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "mask.png")
            Image.fromarray(self.mask).save(path)
            polygon = [(0, 0), (299, 0), (299, 219), (0, 219)]
            missing = ng.build_navgraph(str(path), region_polygon=polygon)
            empty = ng.build_navgraph(
                str(path), region_polygon=polygon,
                level_passages={"version": 1, "items": []})
        for key in ("nodes", "edges", "weights", "components", "coarse_labels"):
            np.testing.assert_array_equal(missing[key], empty[key])
