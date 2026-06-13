"""Sync the on-disk media volume (maps/ and masks/) with a Cloudflare R2 bucket.

Runs inside the main Django service because that's the only Railway service that
has the media volume mounted. The dedicated CRON sidecar service triggers this
via an authenticated POST to the trigger view, which calls this command.

Direction:
    push -- copy local MEDIA_ROOT/{maps,masks} into R2 (prod -> R2).
    pull -- copy R2 into local MEDIA_ROOT/{maps,masks} (R2 -> staging).

Both directions are incremental: objects are compared by size + content MD5
(== R2's ETag for single-part uploads, which covers PNGs and the 5-10 MB
map files we keep on the volume). Files that exist on the destination but not
the source are deleted, so the destination ends up as a true mirror.
"""
import gc
import hashlib
import os
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


SUBDIRS = ("maps", "masks")
PUSH = "push"
PULL = "pull"
_MD5_CHUNK = 1 << 20  # 1 MiB

# This command runs inside the main web process (the only service with the
# volume mounted). boto3's default managed transfer buffers up to
# max_concurrency(10) x multipart_chunksize(8 MiB) ~= 80 MiB per file, which
# spikes the web app's footprint. Our maps are 5-10 MB and masks are smaller,
# so raise the multipart threshold past their size (single-PUT, streamed from
# the file handle) and cap concurrency for the rare larger file.
_TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=32 * 1024 * 1024,
    multipart_chunksize=8 * 1024 * 1024,
    max_concurrency=2,
    use_threads=True,
)


def _same(local_entry, remote_entry):
    """Decide whether a local file already matches a remote object.

    Single-part uploads: remote ETag == file MD5, so we verify both size and
    hash. Multipart uploads (boto3 default >= 8 MB): ETag is
    '<md5-of-part-md5s>-<numparts>', which can't be reconstructed without
    knowing the original part boundaries -- fall back to size-only equality
    in that case. This is what AWS CLI / rclone also do.
    """
    if local_entry is None or remote_entry is None:
        return False
    lsize, lmd5 = local_entry
    rsize, retag = remote_entry
    if lsize != rsize:
        return False
    if "-" in retag:
        return True
    return lmd5 == retag


def _r2_client():
    endpoint = os.environ.get("R2_ENDPOINT_URL")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not (endpoint and access_key and secret_key):
        raise CommandError(
            "R2 credentials missing. Set R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, "
            "and R2_SECRET_ACCESS_KEY on the Django app service."
        )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )


def _file_md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_MD5_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _local_index(local_dir: Path):
    """Return {rel_posix: (size, md5_hex)} for files under local_dir."""
    out = {}
    if not local_dir.is_dir():
        return out
    for path in local_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(local_dir).as_posix()
        out[rel] = (path.stat().st_size, _file_md5(path))
    return out


def _remote_index(client, bucket: str, prefix: str):
    """Return {rel_under_prefix: (size, etag_hex)} for objects under prefix/.

    Cloudflare R2 quirk: ListObjectsV2 on a prefix with no objects raises
    NoSuchKey, where AWS S3 would return an empty Contents list. Treat that as
    an empty index so first-run pushes against a fresh bucket succeed.
    """
    out = {}
    full_prefix = f"{prefix}/"
    paginator = client.get_paginator("list_objects_v2")
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=full_prefix):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                if not key.startswith(full_prefix) or key == full_prefix:
                    continue
                rel = key[len(full_prefix):]
                etag = (obj.get("ETag") or "").strip('"')
                out[rel] = (obj["Size"], etag)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code")
        if code == "NoSuchKey":
            # Empty prefix on R2 -> empty index.
            pass
        else:
            raise
    return out


class Command(BaseCommand):
    help = "Mirror MEDIA_ROOT/maps and /masks between the local volume and an R2 bucket."

    def add_arguments(self, parser):
        parser.add_argument(
            "--direction",
            required=True,
            choices=(PUSH, PULL),
            help="push: local volume -> R2. pull: R2 -> local volume.",
        )

    def handle(self, *args, direction, **opts):
        bucket = os.environ.get("R2_BUCKET")
        if not bucket:
            raise CommandError("R2_BUCKET must be set on the Django app service.")

        media_root = Path(settings.MEDIA_ROOT)

        if direction == PUSH:
            if not media_root.is_dir():
                raise CommandError(
                    f"MEDIA_ROOT '{media_root}' does not exist; refusing to wipe R2."
                )
            non_empty = any(
                (media_root / sub).is_dir()
                and any((media_root / sub).rglob("*"))
                for sub in SUBDIRS
            )
            if not non_empty:
                raise CommandError(
                    f"MEDIA_ROOT '{media_root}' has no files under {SUBDIRS}; "
                    "refusing to wipe R2."
                )
        else:
            media_root.mkdir(parents=True, exist_ok=True)

        client = _r2_client()
        total_uploaded = total_downloaded = total_deleted = 0

        for sub in SUBDIRS:
            local_dir = media_root / sub
            local_dir.mkdir(parents=True, exist_ok=True)

            self.stdout.write(f"[{direction}] {sub}: indexing local + remote...")
            local = _local_index(local_dir)
            remote = _remote_index(client, bucket, sub)

            if direction == PUSH:
                for rel, local_entry in local.items():
                    if _same(local_entry, remote.get(rel)):
                        continue
                    client.upload_file(
                        str(local_dir / rel), bucket, f"{sub}/{rel}",
                        Config=_TRANSFER_CONFIG,
                    )
                    total_uploaded += 1
                for rel in remote.keys() - local.keys():
                    client.delete_object(Bucket=bucket, Key=f"{sub}/{rel}")
                    total_deleted += 1
            else:
                # Safety: if remote returns zero objects while local has files,
                # the most likely cause is a misconfig (wrong R2_ENDPOINT_URL or
                # R2_BUCKET) -- not an intentional wipe. Refuse unless the user
                # explicitly opts in via ALLOW_PULL_WIPE.
                if (
                    len(remote) == 0
                    and len(local) > 0
                    and os.environ.get("ALLOW_PULL_WIPE", "").lower()
                    not in ("1", "true", "yes")
                ):
                    raise CommandError(
                        f"[pull] {sub}: remote prefix is empty but local has "
                        f"{len(local)} file(s). Refusing to wipe local volume "
                        f"-- this usually means R2_ENDPOINT_URL or R2_BUCKET "
                        f"is misconfigured. Set ALLOW_PULL_WIPE=true on the "
                        f"Django service to override."
                    )

                for rel, remote_entry in remote.items():
                    if _same(local.get(rel), remote_entry):
                        continue
                    dst = local_dir / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    client.download_file(
                        bucket, f"{sub}/{rel}", str(dst),
                        Config=_TRANSFER_CONFIG,
                    )
                    total_downloaded += 1
                for rel in local.keys() - remote.keys():
                    (local_dir / rel).unlink(missing_ok=True)
                    total_deleted += 1

            self.stdout.write(
                f"[{direction}] {sub}: local={len(local)} remote={len(remote)}"
            )
            # Drop the per-subdir indexes before the next subdir so we don't hold
            # two full file listings at once.
            local = remote = None

        self.stdout.write(
            f"[{direction}] done. uploaded={total_uploaded} "
            f"downloaded={total_downloaded} deleted={total_deleted}"
        )

        # The sync runs in-process inside the long-lived web service; release the
        # boto3 client (and its connection pool) and reclaim the transfer buffers
        # promptly rather than leaving them for the next GC cycle.
        client = None
        gc.collect()
