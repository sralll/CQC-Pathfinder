from django.db import migrations

def create_settings(apps, schema_editor):
    Profile = apps.get_model('account', 'Profile')
    EditorSettings = apps.get_model('project', 'EditorSettings')
    for profile in Profile.objects.all():
        EditorSettings.objects.get_or_create(profile=profile)

class Migration(migrations.Migration):
    dependencies = [
        ('project', '0002_migrate_data_from_publishedfile'),
        ('account', '0002_migrate_data_from_accounts'),
    ]
    operations = [
        migrations.RunPython(create_settings, migrations.RunPython.noop),
    ]