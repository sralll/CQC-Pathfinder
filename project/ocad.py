import json
import os
import subprocess

from django.conf import settings


class OcadConversionError(Exception):
    pass


def _ocad_editor_scale_factor():
    raw = getattr(settings, "OCAD_EDITOR_SCALE_FACTOR", os.environ.get("OCAD_EDITOR_SCALE_FACTOR", "1"))
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise OcadConversionError("OCAD_EDITOR_SCALE_FACTOR must be a positive number") from exc
    if value <= 0:
        raise OcadConversionError("OCAD_EDITOR_SCALE_FACTOR must be a positive number")
    return value


def convert_ocad_to_editor_assets(source_path, map_filename, mask_filename=None):
    """Convert an OCAD file into an editor PNG and optional vector mask."""
    return _run_ocad_converter(source_path, map_filename, mask_filename=mask_filename)


def convert_ocad_map_to_editor_assets(source_path, map_filename):
    """Convert only the visible editor assets; mask generation runs from PNG."""
    return _run_ocad_converter(
        source_path,
        map_filename,
        skip_mask=True,
    )


def extract_ocad_courses(source_path):
    """Extract course/control-pair JSON without rendering map assets."""
    return _run_ocad_converter(source_path, course_only=True, skip_mask=True)


def _run_ocad_converter(
    source_path,
    map_filename=None,
    mask_filename=None,
    skip_mask=False,
    mask_only=False,
    course_only=False,
):
    script_path = os.path.join(settings.BASE_DIR, "project", "ocad_tools", "convert_ocad.js")
    png_path = os.path.join(settings.MEDIA_ROOT, "maps", map_filename) if map_filename else None
    mask_path = os.path.join(settings.MEDIA_ROOT, "masks", mask_filename) if mask_filename else None
    node_binary = os.environ.get("OCAD_NODE_BINARY", "node")
    scale_factor = _ocad_editor_scale_factor()

    if not os.path.exists(script_path):
        raise OcadConversionError("OCAD converter script missing")

    if not os.path.exists(os.path.join(settings.BASE_DIR, "node_modules", "ocad2geojson")):
        raise OcadConversionError("ocad2geojson is not installed. Run npm install.")

    for output_path in (png_path, mask_path):
        if output_path:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

    cmd = [
        node_binary,
        script_path,
        "--input",
        source_path,
        "--scale-factor",
        str(scale_factor),
    ]
    if png_path:
        cmd.extend(["--png", png_path])
    if mask_path:
        cmd.extend(["--mask", mask_path])
    if skip_mask:
        cmd.extend(["--skip-mask", "true"])
    if mask_only:
        cmd.extend(["--mask-only", "true"])
    if course_only:
        cmd.extend(["--course-only", "true"])

    try:
        completed = subprocess.run(
            cmd,
            cwd=settings.BASE_DIR,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise OcadConversionError(str(exc)) from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise OcadConversionError(detail or "OCAD conversion failed")

    try:
        return json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise OcadConversionError("OCAD converter returned invalid JSON") from exc
