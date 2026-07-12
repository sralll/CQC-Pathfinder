"""CR 8.1 — Python side of the frozen typed-navgraph (v3) artifact contract.

Covers the ``passage_revision`` helper (determinism, sensitivity, and the
cross-language pin that ``navgraph_v3_contract.test.mjs`` also asserts), the v3
``_write_bin`` / ``save_navgraph`` byte layout, and the ``_attach_passage_topology``
validator that rejects malformed in-memory topology before it can produce an
unreadable ``.bin``. A subprocess round-trip (skipped when ``node`` is absent)
proves the Python writer and the JS reader agree byte-for-byte.
"""

import json
import os
import shutil
import struct
import subprocess
import tempfile

import numpy as np
from django.test import SimpleTestCase

from project import navgraph as ng


def _synth_artifact(base_nodes, passages, edges, W=300, H=220):
    """Build a minimal in-memory artifact dict for a typed synthetic graph.

    ``base_nodes`` / each passage's ``points`` are ``(x, y)`` lists; ``edges`` is
    a list of ``(u, v, kind, owner)``. Passage nodes follow the base nodes in the
    given order. Coarse grids are trivial 1x1.
    """
    nodes = list(base_nodes)
    p_start, p_count = [], []
    idx = len(base_nodes)
    for pts in passages:
        p_start.append(idx)
        p_count.append(len(pts))
        nodes.extend(pts)
        idx += len(pts)
    nodes_arr = np.asarray(nodes, dtype=np.int32).reshape(-1, 2)
    E = len(edges)
    edges_arr = np.asarray([[u, v] for (u, v, _, _) in edges], dtype=np.int32).reshape(-1, 2)
    weights = np.ones(E, dtype=np.float32)
    edge_kinds = np.asarray([k for (_, _, k, _) in edges], dtype=np.uint8)
    edge_passage = np.asarray([o for (_, _, _, o) in edges], dtype=np.int32)
    ch = cw = hh = hw = 1
    art = {
        "version": ng.NAVGRAPH_VERSION,
        "nodes": nodes_arr,
        "edges": edges_arr,
        "weights": weights,
        "components": np.ones(nodes_arr.shape[0], dtype=np.int32),
        "edge_kinds": edge_kinds,
        "edge_passage": edge_passage,
        "passage_node_start": np.asarray(p_start, dtype=np.int32),
        "passage_node_count": np.asarray(p_count, dtype=np.int32),
        "base_node_count": len(base_nodes),
        "min_cost_per_px": np.float32(14.0),
        "mask_shape": np.asarray([H, W], dtype=np.int32),
        "coarse_scale": np.int32(10),
        "coarse_origin": np.asarray([20, 30], dtype=np.int32),
        "coarse_minval": np.full((ch, cw), 241, dtype=np.uint8),
        "coarse_clear": np.full((ch, cw), 20, dtype=np.uint8),
        "coarse_labels": np.ones((ch, cw), dtype=np.uint8),
        "hitzone_scale": np.int32(10),
        "coarse_hitzone": np.ones((hh, hw), dtype=np.uint8),
        "stats": {},
    }
    ng._attach_passage_topology(art, level_passages=None, map_width=W, map_height=H)
    return art


def _read_bin_v3(path):
    """Minimal validating parser for the current ``.navgraph.bin``."""
    with open(path, "rb") as f:
        buf = f.read()
    assert buf[:4] == ng.NAVGRAPH_MAGIC, "bad magic"
    (version,) = struct.unpack_from("<I", buf, 4)
    H, W = struct.unpack_from("<ii", buf, 8)
    (min_cost,) = struct.unpack_from("<f", buf, 16)
    N, E = struct.unpack_from("<II", buf, 20)
    coarse_scale, ch, cw = struct.unpack_from("<iii", buf, 28)
    hitzone_scale, hh, hw = struct.unpack_from("<iii", buf, 40)
    base_node_count, P, rev_len = struct.unpack_from("<III", buf, 52)
    coarse_origin = struct.unpack_from("<ii", buf, 64)
    rev = buf[72:72 + rev_len].decode("ascii")
    off = 72 + rev_len
    nodes = np.frombuffer(buf, "<i4", N * 2, off).reshape(-1, 2); off += N * 2 * 4
    edges = np.frombuffer(buf, "<i4", E * 2, off).reshape(-1, 2); off += E * 2 * 4
    off += E * 4  # weights
    off += N * 4  # components
    edge_kinds = np.frombuffer(buf, "<u1", E, off); off += E
    edge_passage = np.frombuffer(buf, "<i4", E, off); off += E * 4
    p_start = np.frombuffer(buf, "<i4", P, off).copy(); off += P * 4
    p_count = np.frombuffer(buf, "<i4", P, off).copy(); off += P * 4
    off += ch * cw + ch * cw + ch * cw + hh * hw
    assert off == len(buf), f"trailing bytes: {off} != {len(buf)}"
    return {
        "version": version, "H": H, "W": W, "N": N, "E": E,
        "base_node_count": base_node_count, "P": P, "revision": rev,
        "nodes": nodes, "edges": edges,
        "edge_kinds": edge_kinds, "edge_passage": edge_passage,
        "coarse_origin": coarse_origin,
        "passage_node_start": p_start, "passage_node_count": p_count,
        "min_cost_per_px": min_cost,
    }


CROSS_LANG_DOC = {
    "version": 1,
    "items": [
        {"id": "8cb8a384-c073-4a4d-9dce-b67e2c6de101",
         "points": [[1420.5, 830.0], [1460.0, 845.5], [1510.0, 870.0]], "width": 24.0},
        {"id": "0aaa1111-2222-3333-4444-555566667777",
         "points": [[10, 20], [30.25, 40]], "width": 12},
    ],
}


class PassageRevisionTests(SimpleTestCase):
    def test_version_is_four(self):
        self.assertEqual(ng.NAVGRAPH_VERSION, 4)

    def test_none_and_empty_document_agree(self):
        self.assertEqual(
            ng.passage_revision(None, 2000, 1500),
            ng.passage_revision({"version": 1, "items": []}, 2000, 1500),
        )

    def test_item_order_independent(self):
        a = {"version": 1, "items": [
            {"id": "bbb", "points": [[1, 2], [3, 4]], "width": 10},
            {"id": "aaa", "points": [[5, 6], [7, 8]], "width": 12},
        ]}
        b = {"version": 1, "items": [a["items"][1], a["items"][0]]}
        self.assertEqual(ng.passage_revision(a, 800, 600), ng.passage_revision(b, 800, 600))

    def test_sensitive_to_point_width_id_and_mask_dims(self):
        base = {"version": 1, "items": [{"id": "aaa", "points": [[1, 2], [3, 4]], "width": 10}]}
        r = ng.passage_revision(base, 800, 600)
        point = {"version": 1, "items": [{"id": "aaa", "points": [[1, 2], [3, 5]], "width": 10}]}
        width = {"version": 1, "items": [{"id": "aaa", "points": [[1, 2], [3, 4]], "width": 11}]}
        pid = {"version": 1, "items": [{"id": "aab", "points": [[1, 2], [3, 4]], "width": 10}]}
        self.assertNotEqual(ng.passage_revision(point, 800, 600), r)
        self.assertNotEqual(ng.passage_revision(width, 800, 600), r)
        self.assertNotEqual(ng.passage_revision(pid, 800, 600), r)
        self.assertNotEqual(ng.passage_revision(base, 801, 600), r)
        self.assertNotEqual(ng.passage_revision(base, 800, 601), r)

    def test_cross_language_pin(self):
        # navgraph_v3_contract.test.mjs asserts the identical strings in JS.
        self.assertEqual(ng.passage_revision(CROSS_LANG_DOC, 2000, 1500), "p1-338caebeb32575fa")
        self.assertEqual(ng.passage_revision(None, 2000, 1500), "p1-7b79b8b7dc80d52b")

    def test_ecma_number_formatting_matches_js(self):
        self.assertEqual(ng._ecma_number(24.0), "24")
        self.assertEqual(ng._ecma_number(24.5), "24.5")
        self.assertEqual(ng._ecma_number(0), "0")
        self.assertEqual(ng._ecma_number(float("nan")), "null")


class AttachPassageTopologyTests(SimpleTestCase):
    def test_base_only_defaults(self):
        art = _synth_artifact([[50, 100], [250, 100]], [], [(0, 1, ng.EDGE_KIND_BASE, -1)])
        self.assertEqual(int(art["base_node_count"]), 2)
        self.assertEqual(art["passage_node_start"].shape[0], 0)
        self.assertTrue((art["edge_kinds"] == ng.EDGE_KIND_BASE).all())
        self.assertTrue((art["edge_passage"] == -1).all())
        self.assertEqual(art["passage_revision"], ng.passage_revision(None, 300, 220))

    def test_rejects_base_edge_with_owner(self):
        with self.assertRaises(ValueError):
            _synth_artifact(
                [[0, 0], [1, 1]], [[[2, 2], [3, 3]]],
                [(0, 1, ng.EDGE_KIND_BASE, 0), (2, 3, ng.EDGE_KIND_PASSAGE, 0)])

    def test_rejects_unknown_kind(self):
        with self.assertRaises(ValueError):
            _synth_artifact([[0, 0], [1, 1]], [], [(0, 1, 7, -1)])

    def test_rejects_owner_out_of_range(self):
        with self.assertRaises(ValueError):
            _synth_artifact(
                [[0, 0], [1, 1]], [[[2, 2], [3, 3]]],
                [(2, 3, ng.EDGE_KIND_PASSAGE, 5)])

    def test_rejects_non_contiguous_passage_range(self):
        art = _synth_artifact(
            [[0, 0], [1, 1]], [[[2, 2], [3, 3]]],
            [(2, 3, ng.EDGE_KIND_PASSAGE, 0)])
        art["passage_node_start"] = np.asarray([3], dtype=np.int32)  # should be 2
        with self.assertRaises(ValueError):
            ng._attach_passage_topology(art, None, 300, 220)


class NavgraphV3SerializationTests(SimpleTestCase):
    def _roundtrip(self, art):
        tmp = tempfile.mkdtemp()
        try:
            mask_path = os.path.join(tmp, "mask.png")
            npz_path, bin_path = ng.save_navgraph(art, mask_path)
            parsed = _read_bin_v3(bin_path)
            with np.load(npz_path, allow_pickle=False) as data:
                keys = set(data.files)
            return parsed, keys
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_zero_passages_roundtrip(self):
        art = _synth_artifact([[50, 100], [250, 100]], [], [(0, 1, ng.EDGE_KIND_BASE, -1)])
        parsed, keys = self._roundtrip(art)
        self.assertEqual(parsed["version"], ng.NAVGRAPH_VERSION)
        self.assertEqual(parsed["coarse_origin"], (20, 30))
        self.assertEqual(parsed["N"], 2)
        self.assertEqual(parsed["base_node_count"], 2)
        self.assertEqual(parsed["P"], 0)
        self.assertEqual(parsed["revision"], ng.passage_revision(None, 300, 220))
        for k in ("edge_kinds", "edge_passage", "passage_node_start",
                  "passage_node_count", "base_node_count", "passage_revision",
                  "coarse_origin"):
            self.assertIn(k, keys)

    def test_multi_passage_roundtrip_layout(self):
        art = _synth_artifact(
            base_nodes=[[50, 20], [250, 20], [50, 200], [250, 200]],
            passages=[[[150, 40], [150, 180]], [[40, 110], [150, 110], [260, 110]]],
            edges=[
                (0, 1, ng.EDGE_KIND_BASE, -1),
                (2, 3, ng.EDGE_KIND_BASE, -1),
                (4, 5, ng.EDGE_KIND_PASSAGE, 0),
                (0, 4, ng.EDGE_KIND_TRANSITION, 0),
                (2, 5, ng.EDGE_KIND_TRANSITION, 0),
                (6, 7, ng.EDGE_KIND_PASSAGE, 1),
                (7, 8, ng.EDGE_KIND_PASSAGE, 1),
            ],
        )
        parsed, _ = self._roundtrip(art)
        self.assertEqual(parsed["N"], 9)
        self.assertEqual(parsed["base_node_count"], 4)
        self.assertEqual(parsed["P"], 2)
        self.assertEqual(list(parsed["passage_node_start"]), [4, 6])
        self.assertEqual(list(parsed["passage_node_count"]), [2, 3])
        # kinds/owners survive the round-trip in edge order
        self.assertEqual(list(parsed["edge_kinds"]), [0, 0, 1, 2, 2, 1, 1])
        self.assertEqual(list(parsed["edge_passage"]), [-1, -1, 0, 0, 0, 1, 1])

    def test_python_writer_reads_in_js(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not available for cross-language round-trip")
        art = _synth_artifact(
            base_nodes=[[50, 20], [250, 20]],
            passages=[[[150, 40], [150, 110], [150, 180]]],
            edges=[
                (0, 1, ng.EDGE_KIND_BASE, -1),
                (2, 3, ng.EDGE_KIND_PASSAGE, 0),
                (3, 4, ng.EDGE_KIND_PASSAGE, 0),
                (0, 2, ng.EDGE_KIND_TRANSITION, 0),
                (1, 4, ng.EDGE_KIND_TRANSITION, 0),
            ],
        )
        from pathlib import Path
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        router = Path(repo, "project", "static", "project", "js",
                      "pathing", "navgraph_router.js").as_uri()
        tmp = tempfile.mkdtemp()
        try:
            _, bin_path = ng.save_navgraph(art, os.path.join(tmp, "mask.png"))
            driver = os.path.join(tmp, "driver.mjs")
            with open(driver, "w", encoding="utf-8") as f:
                f.write(
                    "import { readFileSync } from 'node:fs';\n"
                    f"import {{ loadArtifact }} from '{router}';\n"
                    f"const a = loadArtifact(readFileSync({json.dumps(bin_path)}));\n"
                    "console.log(JSON.stringify({version:a.version,N:a.N,E:a.E,"
                    "P:a.passageCount,base:a.baseNodeCount,rev:a.passageRevision,"
                    "start:Array.from(a.passageNodeStart),count:Array.from(a.passageNodeCount),"
                    "kinds:Array.from(a.edgeKinds),owners:Array.from(a.edgePassage),"
                    "origin:[a.coarseOriginX,a.coarseOriginY]}));\n"
                )
            out = subprocess.run([node, driver], capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr)
            got = json.loads(out.stdout.strip().splitlines()[-1])
            self.assertEqual(got["version"], ng.NAVGRAPH_VERSION)
            self.assertEqual(got["origin"], [20, 30])
            self.assertEqual(got["N"], 5)
            self.assertEqual(got["P"], 1)
            self.assertEqual(got["base"], 2)
            self.assertEqual(got["start"], [2])
            self.assertEqual(got["count"], [3])
            self.assertEqual(got["kinds"], [0, 1, 1, 2, 2])
            self.assertEqual(got["owners"], [-1, 0, 0, 0, 0])
            self.assertEqual(got["rev"], ng.passage_revision(None, 300, 220))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
