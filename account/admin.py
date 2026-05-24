from django.contrib import admin
from django.contrib.auth.admin import UserAdmin, GroupAdmin
from django.contrib.auth.models import User, Group
from django.contrib.auth.forms import UserCreationForm
from .models import Role, Team, Profile, Device, Feedback

admin.site.site_header = 'CQC Pathfinder Admin'
admin.site.index_title = 'Administration'

# --- Profile inline ---
class ProfileInline(admin.StackedInline):
    model = Profile
    can_delete = False
    fk_name = "user"
    verbose_name = "Profile"
    verbose_name_plural = "Profile"


# --- Role admin ---
admin.site.unregister(Group)

@admin.register(Role)
class RoleAdmin(GroupAdmin):
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
    inlines = [ProfileInline]
    add_form = UserCreationForm

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

    def get_fieldsets(self, request, obj=None):
        if obj is None:
            return self.restricted_add_fieldsets
        return self.restricted_fieldsets

    def get_form(self, request, obj=None, **kwargs):
        if obj is None and not request.user.is_superuser:
            kwargs['form'] = self.add_form
        return super().get_form(request, obj, **kwargs)

    def get_inline_instances(self, request, obj=None):
        if obj is None:
            return []
        if not request.user.is_superuser:
            return []
        return super().get_inline_instances(request, obj)

    def formfield_for_manytomany(self, db_field, request, **kwargs):
        if db_field.name == "groups" and not request.user.is_superuser:
            kwargs["queryset"] = Group.objects.exclude(name__in=["Superuser"])
        return super().formfield_for_manytomany(db_field, request, **kwargs)

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        if not change and not request.user.is_superuser:
            try:
                trainer_profile = request.user.profile
                if trainer_profile.active_team:
                    Profile.objects.update_or_create(
                        user=obj,
                        defaults={"active_team": trainer_profile.active_team}
                    )
            except Profile.DoesNotExist:
                pass

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        try:
            active_team = request.user.profile.active_team
            return qs.filter(profile__active_team=active_team)
        except Profile.DoesNotExist:
            return qs.none()

    def get_list_filter(self, request):
        filters = ['groups', 'is_staff']
        if request.user.is_superuser:
            filters.append('profile__active_team')
        return filters

# --- Team admin ---
@admin.register(Team)
class TeamAdmin(admin.ModelAdmin):
    list_display = ("name", "shared_pool")
    list_filter = ("shared_pool",)

    def has_module_permission(self, request):
        return request.user.is_superuser


# --- Device admin ---
@admin.register(Device)
class DeviceAdmin(admin.ModelAdmin):
    list_display = ('team', 'mobile', 'desktop')

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        try:
            active_team = request.user.profile.active_team
            return qs.filter(team=active_team)
        except Profile.DoesNotExist:
            return qs.none()

    def has_view_permission(self, request, obj=None):
        return True
    def has_add_permission(self, request):
        return request.user.is_superuser
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_delete_permission(self, request, obj=None):
        return False

# --- Feedback admin ---
@admin.register(Feedback)
class FeedbackAdmin(admin.ModelAdmin):
    list_display = ('profile', 'created_at', 'short_comment')

    def short_comment(self, obj):
        return obj.comment[:100] + ('...' if len(obj.comment) > 100 else '')
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
