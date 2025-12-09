from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.models import User, Group
from django.contrib.auth.forms import UserCreationForm
from .models import UserProfile, Kader, DeviceCounter
from main.models import Feedback

# --- UserProfile inline ---
class UserProfileInline(admin.StackedInline):
    model = UserProfile
    can_delete = False
    fk_name = "user"
    verbose_name = "Kaderstatus"
    verbose_name_plural = "Kaderstatus"

# --- Group admin ---
admin.site.unregister(Group)
@admin.register(Group)
class GroupAdmin(admin.ModelAdmin):
    def has_module_permission(self, request):
        return request.user.is_superuser
    def has_view_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_add_permission(self, request):
        return request.user.is_superuser
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser

# --- User admin ---
admin.site.unregister(User)
@admin.register(User)
class CustomUserAdmin(UserAdmin):
    inlines = [UserProfileInline]  # define it here, but we’ll hide it dynamically
    add_form = UserCreationForm  # ensure add page uses the UserCreationForm

    # Add/change fieldsets
    restricted_add_fieldsets = (
        (None, {
            "classes": ("wide",),
            "fields": (
                "username",
                "password1",
                "password2",
                "first_name",
                "last_name",
                "email",
                "groups",
                "is_staff",
            ),
        }),
    )

    restricted_fieldsets = (
        ("Password", {"fields": ("password",)}),
        ("Personal info", {"fields": ("first_name", "last_name", "email")}),
        ("Permissions", {"fields": ("groups", "is_staff")}),
    )

    # --- Dynamic fieldsets based on add/change and superuser ---
    def get_fieldsets(self, request, obj=None):
        if obj is None:
            return self.restricted_add_fieldsets
        else:
            return self.restricted_fieldsets

    def get_form(self, request, obj=None, **kwargs):
        if obj is None and not request.user.is_superuser:
            kwargs['form'] = self.add_form
        return super().get_form(request, obj, **kwargs)

    # --- Inline visibility ---
    def get_inline_instances(self, request, obj=None):
        if obj is None:  # hide inline on ADD view
            return []
        if not request.user.is_superuser:  # hide inline for non-superusers
            return []
        return super().get_inline_instances(request, obj)

    # --- Limit groups for non-superusers ---
    def formfield_for_manytomany(self, db_field, request, **kwargs):
        if db_field.name == "groups" and not request.user.is_superuser:
            kwargs["queryset"] = Group.objects.exclude(name__in=["Superuser"])
        return super().formfield_for_manytomany(db_field, request, **kwargs)

    # --- Auto-assign kader when trainer creates a user ---
    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        if not change and not request.user.is_superuser:
            try:
                trainer_profile = request.user.userprofile
                if trainer_profile.kader:
                    UserProfile.objects.update_or_create(
                        user=obj,
                        defaults={"kader": trainer_profile.kader}
                    )
            except UserProfile.DoesNotExist:
                pass

    # --- Queryset filtered by user_kader for non-superusers ---
    def get_queryset(self, request):
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        try:
            user_kader = request.user.userprofile.kader
            return qs.filter(userprofile__kader=user_kader)
        except UserProfile.DoesNotExist:
            return qs.none()

    def get_list_filter(self, request):
        filters = ['groups', 'is_staff']  # always show these
        if request.user.is_superuser:
            filters.append('userprofile__kader')  # only for superusers
        return filters

# --- Kader admin ---
@admin.register(Kader)
class KaderAdmin(admin.ModelAdmin):
    list_display = ("name", "shared_pool")
    list_filter = ("shared_pool",)

    def has_module_permission(self, request):
        return request.user.is_superuser

# --- DeviceCounter admin ---
@admin.register(DeviceCounter)
class DeviceCounterAdmin(admin.ModelAdmin):
    list_display = ('mobile_count', 'desktop_count')
    def has_view_permission(self, request, obj = ...):
        return True
    def has_add_permission(self, request):
        return request.user.is_superuser
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_delete_permission(self, request, obj=None):
        return False

# --- Feedback admin ---
class FeedbackAdmin(admin.ModelAdmin):
    list_display = ('created_at', 'short_comment')

    def short_comment(self, obj):
        return obj.comment[:50] + ('...' if len(obj.comment) > 50 else '')
    short_comment.short_description = "Comment"

    def has_module_permission(self, request):
        return request.user.is_superuser
    def has_view_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser

admin.site.register(Feedback, FeedbackAdmin)