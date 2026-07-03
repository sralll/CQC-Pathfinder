"""Create a PostgreSQL dump and upload it to Cloudflare R2."""
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone

from django.core.management.base import BaseCommand, CommandError

from .sync_volume_to_r2 import _TRANSFER_CONFIG, _r2_client


CONTENT_TYPE = "application/vnd.postgresql.dump"


class _CountingReader:
    """Wraps a file-like object and tallies bytes read, for logging sizes
    without needing a seekable temp file to stat."""

    def __init__(self, fileobj):
        self._fileobj = fileobj
        self.bytes_read = 0

    def read(self, size=-1):
        chunk = self._fileobj.read(size)
        self.bytes_read += len(chunk)
        return chunk


def _truthy(value: str, default: bool = False) -> bool:
    if value == "":
        return default
    return value.lower() in ("1", "true", "yes", "on")


def _normalize_prefix(prefix: str) -> str:
    prefix = prefix.strip().strip("/")
    if not prefix:
        raise CommandError("DB_BACKUP_R2_PREFIX cannot be empty.")
    return prefix


class Command(BaseCommand):
    help = "Create a pg_dump of DATABASE_URL and upload it to an R2 bucket."

    def add_arguments(self, parser):
        parser.add_argument(
            "--prefix",
            default=os.environ.get("DB_BACKUP_R2_PREFIX", "db-backups"),
            help="R2 key prefix for database backups.",
        )
        parser.add_argument(
            "--file-name",
            default=os.environ.get("DB_BACKUP_FILE_NAME", ""),
            help="R2 object filename. Defaults to postgres-<UTC timestamp>.dump.",
        )
        parser.add_argument(
            "--latest-key",
            default=os.environ.get("DB_BACKUP_LATEST_R2_KEY", ""),
            help="Optional R2 key to update with a copy of the latest dump.",
        )

    def handle(self, *args, prefix, file_name, latest_key, **opts):
        db_url = os.environ.get("DATABASE_URL", "")
        bucket = os.environ.get("R2_BUCKET", "")

        if not db_url:
            raise CommandError("DATABASE_URL must be set to create a database backup.")
        if not bucket:
            raise CommandError("R2_BUCKET must be set to upload a database backup.")
        if not shutil.which("pg_dump"):
            raise CommandError(
                "Required command 'pg_dump' was not found. Install PostgreSQL "
                "client tools in the main Django service image."
            )

        prefix = _normalize_prefix(prefix)
        if not file_name:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            file_name = f"postgres-{stamp}.dump"
        key = f"{prefix}/{file_name.lstrip('/')}"

        write_latest = _truthy(
            os.environ.get("DB_BACKUP_WRITE_LATEST", "true"),
            default=True,
        )
        if write_latest and not latest_key:
            latest_key = f"{prefix}/latest.dump"
        elif not write_latest:
            latest_key = ""
        if latest_key:
            latest_key = latest_key.strip().strip("/")

        client = _r2_client()

        # Stream pg_dump's stdout straight into the R2 upload instead of writing
        # a temp file: a temp file's contents sit in the OS page cache, which
        # Railway's memory metric counts, making a dump look like a full-DB-size
        # memory spike even though the Python heap barely grows.
        self.stdout.write("Creating PostgreSQL dump...")
        dump_start = time.monotonic()
        proc = subprocess.Popen(
            [
                "pg_dump",
                "--format=custom",
                "--no-owner",
                "--no-acl",
                db_url,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        counting_reader = _CountingReader(proc.stdout)

        self.stdout.write(f"Uploading database backup to r2://{bucket}/{key}...")
        client.upload_fileobj(
            counting_reader,
            bucket,
            key,
            ExtraArgs={"ContentType": CONTENT_TYPE},
            Config=_TRANSFER_CONFIG,
        )

        # Drain stderr to EOF before wait() so pg_dump can never block on a
        # full stderr pipe.
        stderr_output = proc.stderr.read().decode("utf-8", errors="replace")
        proc.wait()
        if proc.returncode != 0:
            try:
                client.delete_object(Bucket=bucket, Key=key)
            except Exception:
                pass
            raise CommandError(
                f"pg_dump failed with exit code {proc.returncode}: {stderr_output}"
            )

        elapsed = int(time.monotonic() - dump_start)
        self.stdout.write(
            f"PostgreSQL dump completed and uploaded in {elapsed}s "
            f"({counting_reader.bytes_read} bytes)."
        )

        if latest_key:
            client.copy_object(
                Bucket=bucket,
                CopySource={"Bucket": bucket, "Key": key},
                Key=latest_key,
                ContentType=CONTENT_TYPE,
                MetadataDirective="REPLACE",
            )
            self.stdout.write(
                f"Latest database backup pointer updated at "
                f"r2://{bucket}/{latest_key}"
            )
