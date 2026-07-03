"""Create a PostgreSQL dump and upload it to Cloudflare R2."""
import os
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone

from django.core.management.base import BaseCommand, CommandError


CONTENT_TYPE = "application/vnd.postgresql.dump"


def _transfer_config():
    try:
        from boto3.s3.transfer import TransferConfig
    except ModuleNotFoundError as exc:
        raise CommandError(
            f"Python dependency missing: {exc.name}. Install boto3 in the main "
            "Django service image."
        ) from exc

    return TransferConfig(
        multipart_threshold=32 * 1024 * 1024,
        multipart_chunksize=8 * 1024 * 1024,
        max_concurrency=2,
        use_threads=True,
    )


def _r2_client():
    try:
        import boto3
        from botocore.client import Config as BotoConfig
    except ModuleNotFoundError as exc:
        raise CommandError(
            f"Python dependency missing: {exc.name}. Install boto3 in the main "
            "Django service image."
        ) from exc

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

        fd, dump_path = tempfile.mkstemp(prefix="postgres-backup-", suffix=".dump")
        os.close(fd)

        try:
            self.stdout.write("Creating PostgreSQL dump...")
            dump_start = time.monotonic()
            subprocess.run(
                [
                    "pg_dump",
                    "--format=custom",
                    "--no-owner",
                    "--no-acl",
                    "--file",
                    dump_path,
                    db_url,
                ],
                check=True,
            )
            elapsed = int(time.monotonic() - dump_start)
            size = os.path.getsize(dump_path)
            self.stdout.write(
                f"PostgreSQL dump completed in {elapsed}s ({size} bytes)."
            )

            client = _r2_client()
            self.stdout.write(f"Uploading database backup to r2://{bucket}/{key}...")
            upload_start = time.monotonic()
            client.upload_file(
                dump_path,
                bucket,
                key,
                ExtraArgs={"ContentType": CONTENT_TYPE},
                Config=_transfer_config(),
            )

            if latest_key:
                client.copy_object(
                    Bucket=bucket,
                    CopySource={"Bucket": bucket, "Key": key},
                    Key=latest_key,
                    ContentType=CONTENT_TYPE,
                    MetadataDirective="REPLACE",
                )

            elapsed = int(time.monotonic() - upload_start)
            self.stdout.write(f"Database backup uploaded in {elapsed}s.")
            if latest_key:
                self.stdout.write(
                    f"Latest database backup pointer updated at "
                    f"r2://{bucket}/{latest_key}"
                )
        finally:
            try:
                os.unlink(dump_path)
            except FileNotFoundError:
                pass
