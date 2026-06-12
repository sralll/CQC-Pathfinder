from django.db import migrations


def migrate_data(apps, schema_editor):
    Route = apps.get_model('project', 'Route')
    OldResult = apps.get_model('play', 'UserResult')
    Choice = apps.get_model('results', 'Choice')
    ControlPair = apps.get_model('project', 'ControlPair')

    print("Skipping route runtime recalculation; project.0002 already populated Route.noA and Route.run_time.")

    control_pairs_by_key = {}
    for cp_id, file_name, cp_order in (
        ControlPair.objects
        .select_related('file')
        .values_list('id', 'file__name', 'order')
        .order_by('id')
    ):
        # Matches the old migration's `.first()` behavior when filenames are not unique.
        control_pairs_by_key.setdefault((file_name, cp_order), cp_id)

    routes_by_key = {}
    for route_id, cp_id, route_order in Route.objects.values_list('id', 'control_pair_id', 'order').order_by('id'):
        routes_by_key.setdefault((cp_id, route_order), route_id)

    created_before = Choice.objects.count()
    staged = []
    processed = 0
    missing_cp = 0
    missing_route = 0
    batch_size = 1000

    def flush():
        if staged:
            Choice.objects.bulk_create(staged, batch_size=batch_size, ignore_conflicts=True)
            staged.clear()

    for old in OldResult.objects.all().iterator(chunk_size=batch_size):
        processed += 1
        cp_id = control_pairs_by_key.get((old.filename, old.control_pair_index))
        if not cp_id:
            missing_cp += 1
            continue

        selected_route_id = None
        if old.selected_route is not None:
            selected_route_id = routes_by_key.get((cp_id, old.selected_route))
            if not selected_route_id:
                missing_route += 1

        staged.append(Choice(
            user_id=old.user_id,
            control_pair_id=cp_id,
            selected_route_id=selected_route_id,
            choice_time=old.choice_time,
            competition=old.competition,
            timestamp=old.timestamp,
        ))

        if len(staged) >= batch_size:
            flush()

    flush()

    created_after = Choice.objects.count()
    print(
        "Done. "
        f"Processed {processed} old results; "
        f"created {created_after - created_before} new Choices; "
        f"{missing_cp} missing control pairs; "
        f"{missing_route} missing selected routes; "
        f"total in DB: {created_after}"
    )


class Migration(migrations.Migration):

    dependencies = [
        ('results', '0001_initial'),
        ('play', '0006_userresult_longest_route_runtime'),
        ('project', '0003_create_editor_settings_for_existing_users'),
    ]

    operations = [
        migrations.RunPython(migrate_data, migrations.RunPython.noop),
    ]
