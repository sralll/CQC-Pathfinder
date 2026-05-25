from django.db import migrations


def migrate_data(apps, schema_editor):
    OldResult = apps.get_model('play', 'UserResult')
    Choice = apps.get_model('results', 'Choice')
    ControlPair = apps.get_model('project', 'ControlPair')
    Route = apps.get_model('project', 'Route')

    for old in OldResult.objects.select_related('user').all():
        # Find matching control pair by file name and index
        cp = ControlPair.objects.filter(
            file__name=old.filename,
            order=old.control_pair_index,
        ).first()

        if not cp:
            print(f"CP not found: {old.filename} index {old.control_pair_index}")
            continue

        # Find selected route by matching runtime
        selected_route = None
        if old.selected_route is not None:
            selected_route = Route.objects.filter(
                control_pair=cp,
                order=old.selected_route,
            ).first()

        try:
            Choice.objects.create(
                user=old.user,
                control_pair=cp,
                selected_route=selected_route,
                choice_time=old.choice_time,
                competition=old.competition,
                timestamp=old.timestamp,
            )
        except Exception as e:
            print(f"FAILED: {old.filename} CP {old.control_pair_index} user {old.user} — {e}")
            continue

    print(f"Done. Choices: {Choice.objects.count()}")


class Migration(migrations.Migration):

    dependencies = [
        ('results', '0001_initial'),
        ('play', '0006_userresult_longest_route_runtime'),
        ('project', '0004_create_editor_settings_for_existing_users'),
    ]

    operations = [
        migrations.RunPython(migrate_data, migrations.RunPython.noop),
    ]