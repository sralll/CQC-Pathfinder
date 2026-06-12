from django.db import migrations

# Canonical noA + runtime implementation. Same module is imported from the
# project/0002 migration and the recalc-runtimes management command, so the
# numbers stay consistent across migrations + UI.
from project.runtime import calc_route_noA, calc_route_runtime


def migrate_data(apps, schema_editor):
    Route       = apps.get_model('project',  'Route')
    OldResult   = apps.get_model('play',     'UserResult')
    Choice      = apps.get_model('results',  'Choice')
    ControlPair = apps.get_model('project',  'ControlPair')

    # ── Step 1: recompute Route.noA and Route.run_time for every route ──
    # The editor used to count corners as a single-vertex angle; the new
    # method uses a windowed cumulative turn that scales with the file's
    # map scale. Back-fill historic routes so Choices created below (and
    # any other view that reads Route.run_time) match the editor's
    # current numbers.
    recalc_count = 0
    skipped      = 0
    for r in Route.objects.iterator():
        rP = r.rP or []
        if len(rP) < 2:
            r.noA, r.run_time = 0, None
            r.save(update_fields=['noA', 'run_time'])
            skipped += 1
            continue
        scale       = r.control_pair.file.scale if r.control_pair_id else None
        new_noA     = calc_route_noA(rP, scale)
        new_runtime = calc_route_runtime(r.length, new_noA, r.elevation)
        r.noA, r.run_time = new_noA, new_runtime
        r.save(update_fields=['noA', 'run_time'])
        recalc_count += 1
    print(f"Recalculated {recalc_count} routes ({skipped} skipped — too few points)")

    # ── Step 2: migrate UserResult → Choice ──
    created = 0
    for old in OldResult.objects.select_related('user').all():
        cp = ControlPair.objects.filter(
            file__name=old.filename,
            order=old.control_pair_index,
        ).first()
        if not cp:
            print(f"CP not found: {old.filename} index {old.control_pair_index}")
            continue

        selected_route = None
        if old.selected_route is not None:
            selected_route = Route.objects.filter(
                control_pair=cp,
                order=old.selected_route,
            ).first()

        try:
            Choice.objects.create(
                user           = old.user,
                control_pair   = cp,
                selected_route = selected_route,
                choice_time    = old.choice_time,
                competition    = old.competition,
                timestamp      = old.timestamp,
            )
            created += 1
        except Exception as e:
            print(f"FAILED: {old.filename} CP {old.control_pair_index} user {old.user} — {e}")
            continue

    print(f"Done. {created} new Choices created; total in DB: {Choice.objects.count()}")


class Migration(migrations.Migration):

    dependencies = [
        ('results', '0001_initial'),
        ('play',    '0006_userresult_longest_route_runtime'),
        ('project', '0003_create_editor_settings_for_existing_users'),
    ]

    operations = [
        migrations.RunPython(migrate_data, migrations.RunPython.noop),
    ]
