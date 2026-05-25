from django.contrib.auth.decorators import user_passes_test

def role_required(role_name):
    def in_role(u):
        return u.is_authenticated and u.groups.filter(name=role_name).exists()
    return user_passes_test(in_role)