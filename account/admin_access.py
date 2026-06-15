"""Shared admin access policy.

Non-superuser staff (the per-team members who get `is_staff`) are limited to an
explicit allow-list of models, each scoped to their own `active_team`. The
allow-listed admins set that up individually; this module provides the inverse:
a mixin that hides a model from everyone except superusers, so any model NOT on
the allow-list is locked down by default rather than leaking based on whichever
Django permissions happen to be granted to a staff user's group.

Apply it as the FIRST base class so its permission checks take precedence over
``admin.ModelAdmin``:

    class FooAdmin(StaffHiddenAdmin, admin.ModelAdmin):
        ...
"""


class StaffHiddenAdmin:
    """Hide the model from non-superusers entirely.

    For superusers every check falls through to ``super()``, so any action the
    concrete admin deliberately disables (e.g. ``has_add_permission`` returning
    ``False`` on an inline-managed model) is still respected for superusers too.
    """

    def has_module_permission(self, request):
        return request.user.is_superuser

    def has_view_permission(self, request, obj=None):
        return request.user.is_superuser and super().has_view_permission(request, obj)

    def has_add_permission(self, request):
        return request.user.is_superuser and super().has_add_permission(request)

    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser and super().has_change_permission(request, obj)

    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser and super().has_delete_permission(request, obj)
