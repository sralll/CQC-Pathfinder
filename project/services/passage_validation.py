"""Validate and canonicalize the persisted level-passage document.

This module deliberately does not inspect a map or rasterize geometry.  Passage
coordinates are in mask-pixel space, but bounds that depend on the current mask
belong to the browser/worker runtime.
"""

import json
import math
import uuid


LEVEL_PASSAGES_VERSION = 1
MAX_PASSAGES = 64
MAX_POINTS_PER_PASSAGE = 256
MIN_PASSAGE_WIDTH = 2.0
MAX_PASSAGE_WIDTH = 256.0
MAX_PASSAGE_ID_LENGTH = 64
MAX_LEVEL_PASSAGES_BYTES = 512 * 1024


class LevelPassagesValidationError(ValueError):
    """Raised when a level-passage document violates the v1 contract."""


def empty_level_passages():
    """Return a fresh canonical empty document."""
    return {"version": LEVEL_PASSAGES_VERSION, "items": []}


def _fail(detail):
    raise LevelPassagesValidationError(detail)


def _finite_number(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{path} must be a number")
    value = float(value)
    if not math.isfinite(value):
        _fail(f"{path} must be finite")
    return value


def _serialized_size(value):
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        _fail(f"document is not valid JSON: {exc}")
    return len(encoded)


def normalize_level_passages(value):
    """Validate and return the canonical v1 representation.

    ``None`` (including a missing request field supplied via ``dict.get``) is
    the backwards-compatible empty state.  All non-empty inputs are validated
    as one document; invalid items are never silently dropped.
    """
    if value is None:
        return empty_level_passages()

    if _serialized_size(value) > MAX_LEVEL_PASSAGES_BYTES:
        _fail("document exceeds the maximum serialized size")
    if not isinstance(value, dict):
        _fail("document must be an object")

    version = value.get("version")
    if isinstance(version, bool) or version != LEVEL_PASSAGES_VERSION:
        _fail(f"unsupported version: {version!r}")

    items = value.get("items")
    if not isinstance(items, list):
        _fail("items must be an array")
    if len(items) > MAX_PASSAGES:
        _fail(f"items must contain at most {MAX_PASSAGES} passages")

    normalized_items = []
    seen_ids = set()
    for item_index, item in enumerate(items):
        path = f"items[{item_index}]"
        if not isinstance(item, dict):
            _fail(f"{path} must be an object")

        passage_id = item.get("id")
        if not isinstance(passage_id, str) or not passage_id:
            _fail(f"{path}.id must be a non-empty UUID string")
        if len(passage_id) > MAX_PASSAGE_ID_LENGTH:
            _fail(f"{path}.id exceeds {MAX_PASSAGE_ID_LENGTH} characters")
        try:
            canonical_id = str(uuid.UUID(passage_id))
        except (ValueError, AttributeError, TypeError):
            _fail(f"{path}.id must be a UUID string")
        if canonical_id in seen_ids:
            _fail(f"{path}.id duplicates another passage id")
        seen_ids.add(canonical_id)

        points = item.get("points")
        if not isinstance(points, list):
            _fail(f"{path}.points must be an array")
        if not 2 <= len(points) <= MAX_POINTS_PER_PASSAGE:
            _fail(
                f"{path}.points must contain between 2 and "
                f"{MAX_POINTS_PER_PASSAGE} points"
            )

        normalized_points = []
        distinct_points = set()
        for point_index, point in enumerate(points):
            point_path = f"{path}.points[{point_index}]"
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                _fail(f"{point_path} must be an [x, y] pair")
            x = _finite_number(point[0], f"{point_path}[0]")
            y = _finite_number(point[1], f"{point_path}[1]")
            normalized_points.append([x, y])
            distinct_points.add((x, y))
        if len(distinct_points) < 2:
            _fail(f"{path}.points must contain at least two distinct positions")

        width = _finite_number(item.get("width"), f"{path}.width")
        if not MIN_PASSAGE_WIDTH <= width <= MAX_PASSAGE_WIDTH:
            _fail(
                f"{path}.width must be between {MIN_PASSAGE_WIDTH:g} and "
                f"{MAX_PASSAGE_WIDTH:g}"
            )

        normalized_items.append({
            "id": canonical_id,
            "points": normalized_points,
            "width": width,
        })

    normalized = {"version": LEVEL_PASSAGES_VERSION, "items": normalized_items}
    if _serialized_size(normalized) > MAX_LEVEL_PASSAGES_BYTES:
        _fail("normalized document exceeds the maximum serialized size")
    return normalized
