"""WP 6.1 build-time polygon pruning and legality regression tests."""

import tempfile
from pathlib import Path

import numpy as np
from django.test import SimpleTestCase
from PIL import Image

from project import navgraph as ng


class RegionRasterTests(SimpleTestCase):
    def test_region_revision_is_deterministic_and_sensitive(self):
        a = ng.region_revision([(1, 1), (8, 1), (8, 8)], 10, 10)
        self.assertEqual(a, ng.region_revision([[1, 1], [8, 1], [8, 8]], 10, 10))
        self.assertNotEqual(a, ng.region_revision([(1, 1), (7, 1), (8, 8)], 10, 10))
        self.assertIsNone(ng.region_revision(None, 10, 10))

    def test_invalid_nonempty_polygon_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least 3 points"):
            ng._rasterize_region_full([(1, 1), (8, 8)], 20, 20)
        with self.assertRaisesRegex(ValueError, "non-zero area"):
            ng._rasterize_region_full([(1, 1), (5, 5), (9, 9)], 20, 20)
        with self.assertRaisesRegex(ValueError, "outside"):
            ng._rasterize_region_full([(1, 1), (19, 1), (20, 19)], 20, 20)

    def test_coarse_hitzone_is_derived_from_full_raster(self):
        polygon = [(1, 1), (30, 1), (30, 12), (12, 12), (12, 30), (1, 30)]
        full = ng._rasterize_region_full(polygon, 32, 32)
        coarse = ng._rasterize_region(
            polygon, 32, 32, ds=8, full_raster=full)
        expected = np.asarray([
            [full[y * 8:(y + 1) * 8, x * 8:(x + 1) * 8].all()
             for x in range(4)]
            for y in range(4)
        ])
        np.testing.assert_array_equal(coarse, expected)


class RegionPrunedBuildTests(SimpleTestCase):
    def test_benchmark_switch_keeps_polygon_authority_without_pruning(self):
        polygon = [(10, 10), (169, 10), (169, 55), (70, 55), (70, 149), (10, 149)]
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            mask_path = Path(directory) / "mask.png"
            Image.fromarray(np.full((160, 180), 255, dtype=np.uint8)).save(mask_path)
            artifact = ng.build_navgraph(
                str(mask_path), region_polygon=polygon, prune_region=False)

        self.assertEqual(artifact["stats"]["hitzone_source"], "polygon")
        self.assertFalse(artifact["stats"]["region_prune_enabled"])
        self.assertEqual(
            artifact["stats"]["nodes_before_region_prune"],
            artifact["stats"]["nodes_after_region_prune"],
        )
        np.testing.assert_array_equal(artifact["coarse_origin"], [0, 0])

    def test_concave_region_prunes_nodes_and_all_serialized_edges(self):
        polygon = [
            (10, 10), (169, 10), (169, 55),
            (70, 55), (70, 149), (10, 149),
        ]
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            mask_path = Path(directory) / "mask.png"
            Image.fromarray(np.full((160, 180), 255, dtype=np.uint8)).save(mask_path)
            artifact = ng.build_navgraph(str(mask_path), region_polygon=polygon)

        region = ng._rasterize_region_full(polygon, 160, 180)
        legality_mask = np.full((160, 180), 255, dtype=np.uint8)
        legality_mask[~region] = ng.IMPASSABLE

        self.assertGreater(len(artifact["nodes"]), 0)
        self.assertTrue(all(region[y, x] for x, y in artifact["nodes"]))
        self.assertTrue(all(
            ng._line_cost(
                legality_mask,
                *artifact["nodes"][u], *artifact["nodes"][v],
            ) is not None
            for u, v in artifact["edges"]
        ))
        stats = artifact["stats"]
        self.assertGreater(
            stats["nodes_before_region_prune"],
            stats["nodes_after_region_prune"],
        )
        self.assertEqual(stats["edges_after_region_prune"], len(artifact["edges"]))
        self.assertGreater(stats["region_pruned_fraction"], 0)
        self.assertIn("region_prune", stats["timings"])
        self.assertGreater(int(artifact["coarse_origin"][0]), 0)
        self.assertGreater(int(artifact["coarse_origin"][1]), 0)
        self.assertLess(artifact["coarse_labels"].shape[0], 160 // ng.SAMPLE_DS)
        self.assertLess(artifact["coarse_labels"].shape[1], 180 // ng.SAMPLE_DS)
