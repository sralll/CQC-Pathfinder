"""Sync the on-disk media volume (maps/ and masks/) with a Cloudflare R2 bucket.

Runs inside the main Django service because that's the only Railway service that
has the media volume mounted. The dedicated CRON sidecar service triggers this
via an authenticated POST to the trigger view, which calls this command.

Direction:
    push -- copy local MEDIA_ROOT/{maps,masks} into R2 (prod -> R2).
    pull -- copy R2 into local MEDIA_ROOT/{maps,masks} (R2 -> staging).

Both directions are incremental: files are compared by size + mtime, never by
content. The previous version hashed (MD5'd) every file to compare against R2's
ETag, which read the *entire volume* off disk on every run -- harmless to the
Python heap, but it fills the OS page cache, and Railway's cgroup memory metric
counts page cache, so a sync of a 1.5 GB volume showed ~1.5 GB "used" even when
only a couple of files changed. size + mtime comes from os.stat() (inode
metadata only, no data blocks read) and the R2 object listing's Size +
LastModified (free, no extra API calls, no downloads), so an unchanged file is
never read at all. Files that exist on the destination but not the source are
deleted, so the destination ends up as a true mirror.
"""
import gc
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
# Slack (seconds) when comparing a source file's mtime to the destination's
# timestamp, to absorb clock skew between the volume's filesystem and R2's
# server clock. After any transfer the destination is written *after* the
# source, so its timestamp is strictly newer -- the comparison can't oscillate.
_MTIME_SLACK = 5

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


def _needs_transfer(src_entry, dst_entry):
    """Decide whether to copy src -> dst, comparing only (size, mtime).

    Transfer when the destination is missing, the sizes differ, or the source
    is strictly newer than the destination (beyond _MTIME_SLACK). Both entries
    are (size_bytes, mtime_epoch); for a remote object the "mtime" is its R2
    LastModified. No file contents are ever read.
    """
    if dst_entry is None:
        return True
    ssize, smtime = src_entry
    dsize, dmtime = dst_entry
    if ssize != dsize:
        return True
    return smtime > dmtime + _MTIME_SLACK


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


def _local_index(local_dir: Path):
    """Return {rel_posix: (size, mtime_epoch)} for files under local_dir.

    Uses a single os.stat() per entry (inode metadata only) -- file contents
    are never read, so this does not touch the OS page cache.
    """
    out = {}
    if not local_dir.is_dir():
        return out
    for path in local_dir.rglob("*"):
        if not path.is_file():
            continue
        st = path.stat()
        rel = path.relative_to(local_dir).as_posix()
        out[rel] = (st.st_size, st.st_mtime)
    return out


def _remote_index(client, bucket: str, prefix: str):
    """Return {rel_under_prefix: (size, last_modified_epoch)} for objects.

    Size and LastModified both come from the ListObjectsV2 page -- no HeadObject
    calls, no downloads. Cloudflare R2 quirk: ListObjectsV2 on a prefix with no
    objects raises NoSuchKey, where AWS S3 would return an empty Contents list.
    Treat that as an empty index so first-run pushes against a fresh bucket
    succeed.
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
                out[rel] = (obj["Size"], obj["LastModified"].timestamp())
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
                    # src=local, dst=remote: upload if missing/larger/newer.
                    if not _needs_transfer(local_entry, remote.get(rel)):
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
                    # src=remote, dst=local: download if missing/larger/newer.
                    if not _needs_transfer(remote_entry, local.get(rel)):
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
