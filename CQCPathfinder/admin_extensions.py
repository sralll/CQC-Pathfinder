"""Custom admin views — wired into the default AdminSite via apps.py."""
import os

from django.contrib import admin
from django.contrib.admin.views.decorators import staff_member_required
from django.http import HttpResponseBadRequest, HttpResponseRedirect
from django.shortcuts import render
from django.urls import path, reverse
from django.utils.decorators import method_decorator


# ── R2 storage browser ────────────────────────────────────────────────────────

R2_SUBDIRS = ("maps", "masks")
_R2_PAGE_SIZE = 200


def _r2_env():
    return {
        "endpoint":   os.environ.get("R2_ENDPOINT_URL"),
        "access_key": os.environ.get("R2_ACCESS_KEY_ID"),
        "secret_key": os.environ.get("R2_SECRET_ACCESS_KEY"),
        "bucket":     os.environ.get("R2_BUCKET"),
    }


def _r2_client_or_none():
    env = _r2_env()
    if not all(env.values()):
        return None, env
    try:
        import boto3
        from botocore.client import Config as BotoConfig
    except ImportError:
        return None, env

    client = boto3.client(
        "s3",
        endpoint_url=env["endpoint"],
        aws_access_key_id=env["access_key"],
        aws_secret_access_key=env["secret_key"],
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )
    return client, env


def _list_r2_objects(client, bucket, prefix, max_keys=_R2_PAGE_SIZE, continuation_token=None):
    kwargs = {
        "Bucket": bucket,
        "Prefix": prefix,
        "MaxKeys": max_keys,
    }
    if continuation_token:
        kwargs["ContinuationToken"] = continuation_token
    return client.list_objects_v2(**kwargs)


@staff_member_required
def r2_browser_view(request):
    if not request.user.is_superuser:
        return HttpResponseBadRequest("Superuser required.")

    prefix = request.GET.get("prefix", "maps/")
    if not any(prefix.startswith(p + "/") or prefix == p + "/" or prefix == p
               for p in R2_SUBDIRS):
        prefix = "maps/"

    token = request.GET.get("token") or None

    client, env = _r2_client_or_none()
    context = {
        "title":            "R2 storage browser",
        "subdirs":          R2_SUBDIRS,
        "active_prefix":    prefix,
        "credentials_set":  all(env.values()),
        "endpoint_label":   env["endpoint"] or "(not set)",
        "bucket_label":     env["bucket"] or "(not set)",
        "objects":          [],
        "next_token":       None,
        "object_count":     0,
        "error":            None,
        "site_header":      admin.site.site_header,
        "site_title":       admin.site.site_title,
        "site_url":         "/",
        "has_permission":   True,
        "available_apps":   admin.site.get_app_list(request),
        "is_popup":         False,
        "is_nav_sidebar_enabled": False,
        "user":             request.user,
        "opts":             None,
    }

    if client is None:
        if not all(env.values()):
            context["error"] = (
                "R2 credentials are not configured. Set R2_ENDPOINT_URL, "
                "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET in the "
                "environment to enable browsing."
            )
        else:
            context["error"] = "boto3 not installed; cannot connect to R2."
        return render(request, "admin/r2_browser.html", context)

    try:
        resp = _list_r2_objects(client, env["bucket"], prefix, continuation_token=token)
    except Exception as exc:
        context["error"] = f"R2 list_objects_v2 failed: {exc}"
        return render(request, "admin/r2_browser.html", context)

    contents = resp.get("Contents", []) or []
    objects = []
    for item in contents:
        key = item.get("Key", "")
        size = item.get("Size", 0)
        last_modified = item.get("LastModified")
        etag = (item.get("ETag", "") or "").strip('"')
        objects.append({
            "key":            key,
            "filename":       key.rsplit("/", 1)[-1] or key,
            "size_human":     _human_size(size),
            "size":           size,
            "last_modified":  last_modified,
            "etag":           etag,
        })

    context["objects"]      = objects
    context["object_count"] = resp.get("KeyCount", len(objects))
    context["next_token"]   = resp.get("NextContinuationToken") if resp.get("IsTruncated") else None
    return render(request, "admin/r2_browser.html", context)


def _human_size(size):
    if size is None:
        return "—"
    size = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} TB"


# ── AdminSite extension ───────────────────────────────────────────────────────

_original_get_urls = admin.site.get_urls


def _patched_get_urls():
    return [
        path("r2/", admin.site.admin_view(r2_browser_view), name="r2_browser"),
    ] + _original_get_urls()


def install():
    """Idempotently patch admin.site.get_urls to add the R2 browser."""
    if getattr(admin.site, "_r2_browser_installed", False):
        return
    admin.site.get_urls = _patched_get_urls
    admin.site._r2_browser_installed = True
