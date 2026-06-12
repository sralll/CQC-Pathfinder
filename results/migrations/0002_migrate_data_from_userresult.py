from django.db import migrations


def migrate_data(apps, schema_editor):
    Route = apps.get_model('project', 'Route')
    OldFile = apps.get_model('coursesetter', 'publishedFile')
    OldResult = apps.get_model('play', 'UserResult')
    Choice = apps.get_model('results', 'Choice')
    ControlPair = apps.get_model('project', 'ControlPair')
    Team = apps.get_model('account', 'Team')

    print("Skipping route runtime recalculation; project.0002 already populated Route.noA and Route.run_time.")

    team_ids_by_name = dict(Team.objects.values_list('name', 'id'))

    def runtime_key(value):
        try:
            return round(float(value), 2)
        except (TypeError, ValueError):
            return None

    legacy_route_order_by_team_key = {}
    legacy_route_order_by_file_key = {}
    for file_name, team_name, data in (
        OldFile.objects
        .select_related('kader')
        .values_list('filename', 'kader__name', 'data')
    ):
        for cp_order, cp_data in enumerate((data or {}).get('cP', [])):
            for route_order, route_data in enumerate(cp_data.get('route', [])):
                key = runtime_key(route_data.get('runTime'))
                if key is None:
                    continue
                legacy_route_order_by_team_key.setdefault((file_name, cp_order, team_name, key), route_order)
                legacy_route_order_by_file_key.setdefault((file_name, cp_order, key), route_order)

    control_pairs_by_team_key = {}
    control_pairs_by_file_key = {}
    for cp_id, file_name, team_name, cp_order in (
        ControlPair.objects
        .select_related('file', 'file__team')
        .values_list('id', 'file__name', 'file__team__name', 'order')
        .order_by('id')
    ):
        # Prefer the old UserResult.kader snapshot. The same filename can exist
        # in multiple teams, so filename + CP order alone can attach choices to
        # the wrong migrated File/ControlPair.
        control_pairs_by_team_key.setdefault((file_name, cp_order, team_name), cp_id)
        control_pairs_by_file_key.setdefault((file_name, cp_order), cp_id)

    routes_by_key = {}
    for route_id, cp_id, route_order in Route.objects.values_list('id', 'control_pair_id', 'order').order_by('id'):
        routes_by_key.setdefault((cp_id, route_order), route_id)

    created_before = Choice.objects.count()
    staged = []
    processed = 0
    missing_cp = 0
    missing_route = 0
    recovered_route = 0
    batch_size = 1000

    def flush():
        if staged:
            Choice.objects.bulk_create(staged, batch_size=batch_size, ignore_conflicts=True)
            staged.clear()

    for old in OldResult.objects.select_related('kader').all().iterator(chunk_size=batch_size):
        processed += 1
        team_name = old.kader.name if old.kader_id else None
        team_id = team_ids_by_name.get(team_name)
        cp_id = control_pairs_by_team_key.get(
            (old.filename, old.control_pair_index, team_name)
        )
        if not cp_id:
            cp_id = control_pairs_by_file_key.get((old.filename, old.control_pair_index))
        if not cp_id:
            missing_cp += 1
            continue

        selected_route_id = None
        selected_route_order = old.selected_route
        if selected_route_order is None:
            key = runtime_key(old.selected_route_runtime)
            if key is not None:
                selected_route_order = legacy_route_order_by_team_key.get(
                    (old.filename, old.control_pair_index, team_name, key)
                )
                if selected_route_order is None:
                    selected_route_order = legacy_route_order_by_file_key.get(
                        (old.filename, old.control_pair_index, key)
                    )
                if selected_route_order is not None:
                    recovered_route += 1

        if selected_route_order is not None:
            selected_route_id = routes_by_key.get((cp_id, selected_route_order))
            if not selected_route_id:
                missing_route += 1

        staged.append(Choice(
            user_id=old.user_id,
            team_id=team_id,
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
        f"{recovered_route} selected routes recovered from legacy runtimes; "
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
