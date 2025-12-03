from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.models import User, Group
from django.contrib.auth.forms import UserCreationForm
from .models import UserProfile, Kader, DeviceCounter

class UserProfileInline(admin.StackedInline):
    model = UserProfile
    can_delete = False
    fk_name = "user"

    verbose_name = "Kaderstatus"
    verbose_name_plural = "Kaderstatus"

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
    def has_delete_permission(self, request):
        return request.user.is_superuser

admin.site.unregister(User)

@admin.register(User)
class CustomUserAdmin(UserAdmin):
    inlines = [UserProfileInline]  # define it here, but we’ll hide it dynamically

    def get_inline_instances(self, request, obj=None):
        # Only show the inline for superusers
        if not request.user.is_superuser:
            return []  # hide all inlines
        return super().get_inline_instances(request, obj)

    # ensure add page uses the UserCreationForm (has password1/password2)
    add_form = UserCreationForm

    # fields shown when creating a user (add page)
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

    # fields shown when editing a user (change page)
    restricted_fieldsets = (
        ("Password", {
            "fields": ("password",),  # this enables the reset password link
        }),
        ("Personal info", {
            "fields": ("first_name", "last_name", "email"),
        }),
        ("Permissions", {
            "fields": ("groups","is_staff"),
        }),
    )

    def get_fieldsets(self, request, obj=None):
        if obj is None:
            return self.restricted_add_fieldsets
        else:
            return self.restricted_fieldsets

    def get_form(self, request, obj=None, **kwargs):
        if obj is None and not request.user.is_superuser:
            kwargs['form'] = self.add_form
        return super().get_form(request, obj, **kwargs)


    def get_inline_instances(self, request, obj=None):
        # ✅ No inline at all on ADD view
        if obj is None:
            return []

        # ✅ On CHANGE view: only for superusers
        if not request.user.is_superuser:
            return []

        return super().get_inline_instances(request, obj)

    def formfield_for_manytomany(self, db_field, request, **kwargs):
        # limit which groups non-superusers can assign (optional)
        if db_field.name == "groups" and not request.user.is_superuser:
            kwargs["queryset"] = Group.objects.exclude(name__in=["Superuser"])
        return super().formfield_for_manytomany(db_field, request, **kwargs)
    
    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)

        # Only assign Kader automatically when creating a new user (not editing)
        if not change and not request.user.is_superuser:
            try:
                trainer_profile = request.user.userprofile
                if trainer_profile.kader:
                    UserProfile.objects.update_or_create(
                        user=obj,
                        defaults={"kader": trainer_profile.kader}
                    )
            except UserProfile.DoesNotExist:
                pass  # trainer has no profile, do nothing

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        try:
            user_kader = request.user.userprofile.kader
            return qs.filter(userprofile__kader=user_kader)
        except UserProfile.DoesNotExist:
            return qs.none()

@admin.register(Kader)
class KaderAdmin(admin.ModelAdmin):
    def has_module_permission(self, request):
        return request.user.is_superuser
    
from django.contrib import admin
from .models import DeviceCounter

@admin.register(DeviceCounter)
class DeviceCounterAdmin(admin.ModelAdmin):
    list_display = ('mobile_count', 'desktop_count')
    readonly_fields = ('mobile_count', 'desktop_count')

    def has_view_permission(self, request, obj=None):
        # Only superusers can view
        return request.user.is_superuser

    def has_add_permission(self, request):
        return False  # Disable adding

    def has_change_permission(self, request, obj=None):
        return False  # Disable editing

    def has_delete_permission(self, request, obj=None):
        return False  # Disable deleting

from main.models import Feedback

class FeedbackAdmin(admin.ModelAdmin):
    list_display = ('created_at', 'short_comment')

    def short_comment(self, obj):
        # Show first 50 characters
        return obj.comment[:50] + ('...' if len(obj.comment) > 50 else '')
    short_comment.short_description = "Comment"

    def has_module_permission(self, request):
        # Only show module to superusers
        return request.user.is_superuser

    def has_view_permission(self, request, obj=None):
        return request.user.is_superuser

    def has_add_permission(self, request):
        return False  # Superusers cannot add comments manually here

    def has_change_permission(self, request, obj=None):
        return False  # Superusers cannot change comments

    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser  # Can delete if needed

admin.site.register(Feedback, FeedbackAdmin)