"""Timing telemetry for the pathfinding pipeline.

Two narrow tables, intentionally append-only and detached from the rest of the
domain — both can be truncated at any time without affecting application
state. They exist so we can compare cold/warm latency, build cost, and route
success across the staging fleet while iterating on the visibility-graph
implementation.
"""

from django.db import models


class NavGraphBuildTime(models.Model):
    """One row per visibility-graph sidecar build."""

    TRIGGER_UNET = "unet"
    TRIGGER_REBUILD = "rebuild_endpoint"
    TRIGGER_MANAGEMENT = "management"
    TRIGGER_LAZY = "lazy"
    TRIGGER_CHOICES = [
        (TRIGGER_UNET, "After UNet mask generation"),
        (TRIGGER_REBUILD, "Editor rebuild endpoint"),
        (TRIGGER_MANAGEMENT, "build_navgraphs management command"),
        (TRIGGER_LAZY, "Lazy build inside query.run"),
    ]

    mask_basename = models.CharField(max_length=255, db_index=True)
    mask_width = models.IntegerField(null=True, blank=True)
    mask_height = models.IntegerField(null=True, blank=True)

    n_nodes = models.IntegerField(null=True, blank=True)
    n_edges = models.IntegerField(null=True, blank=True)
    n_components = models.IntegerField(null=True, blank=True)
    main_component_pct = models.FloatField(null=True, blank=True)

    build_seconds = models.FloatField()
    sidecar_bytes = models.BigIntegerField(null=True, blank=True)
    sidecar_version = models.IntegerField(null=True, blank=True)

    trigger = models.CharField(max_length=32, choices=TRIGGER_CHOICES,
                               default=TRIGGER_LAZY, db_index=True)
    error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ("-created_at",)
        verbose_name = "NavGraph build timing"
        verbose_name_plural = "NavGraph build timings"

    def __str__(self):
        return f"navgraph {self.mask_basename}: {self.build_seconds:.1f}s ({self.trigger})"


class PathfindingTime(models.Model):
    """One row per /pathfinding/find/ call (incl. auto_pathfind invocations)."""

    SRC_EDITOR_BUTTON = "editor_button"
    SRC_EDITOR_AUTO = "editor_auto"
    SRC_COURSESETTER = "coursesetter"
    SRC_BATCH = "batch"
    SRC_BENCHMARK = "benchmark"
    SRC_UNKNOWN = "unknown"
    SOURCE_CHOICES = [
        (SRC_EDITOR_BUTTON, "Editor: Neue Route button"),
        (SRC_EDITOR_AUTO, "Editor: auto_pathfind on CP creation"),
        (SRC_COURSESETTER, "Coursesetter (legacy)"),
        (SRC_BATCH, "Batch pathfinding"),
        (SRC_BENCHMARK, "Benchmark management command"),
        (SRC_UNKNOWN, "Unknown / unset"),
    ]

    mask_basename = models.CharField(max_length=255, db_index=True)
    start_x = models.IntegerField()
    start_y = models.IntegerField()
    ziel_x = models.IntegerField()
    ziel_y = models.IntegerField()

    n_routes_requested = models.IntegerField()
    n_routes_returned = models.IntegerField()
    n_existing_routes = models.IntegerField(default=0)
    n_blocked_features = models.IntegerField(default=0)

    query_seconds = models.FloatField()
    success = models.BooleanField(default=True)
    cold = models.BooleanField(default=False,
                               help_text="Suspected first query for this mask in this process.")
    source = models.CharField(max_length=32, choices=SOURCE_CHOICES,
                              default=SRC_UNKNOWN, db_index=True)
    error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ("-created_at",)
        verbose_name = "Pathfinding timing"
        verbose_name_plural = "Pathfinding timings"

    def __str__(self):
        label = "ok" if self.success else "err"
        return (f"pathfinding {self.mask_basename}: {self.query_seconds*1000:.0f}ms "
                f"{label} ({self.n_routes_returned}/{self.n_routes_requested})")
