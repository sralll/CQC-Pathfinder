from django.contrib import admin

from .models import NavGraphBuildTime, PathfindingTime


@admin.register(NavGraphBuildTime)
class NavGraphBuildTimeAdmin(admin.ModelAdmin):
    list_display = ("created_at", "mask_basename", "build_seconds", "n_nodes",
                    "n_edges", "main_component_pct", "trigger", "sidecar_version")
    list_filter = ("trigger", "sidecar_version")
    search_fields = ("mask_basename",)
    date_hierarchy = "created_at"
    readonly_fields = tuple(f.name for f in NavGraphBuildTime._meta.fields)


@admin.register(PathfindingTime)
class PathfindingTimeAdmin(admin.ModelAdmin):
    list_display = ("created_at", "mask_basename", "query_seconds_ms",
                    "n_routes_returned", "n_routes_requested",
                    "n_existing_routes", "n_blocked_features",
                    "success", "cold", "source")
    list_filter = ("source", "success", "cold")
    search_fields = ("mask_basename", "error")
    date_hierarchy = "created_at"
    readonly_fields = tuple(f.name for f in PathfindingTime._meta.fields)

    @admin.display(ordering="query_seconds", description="ms")
    def query_seconds_ms(self, obj):
        return f"{obj.query_seconds * 1000:.0f}"
