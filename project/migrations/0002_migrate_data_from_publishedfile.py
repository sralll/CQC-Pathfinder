from django.db import migrations

# Canonical noA + run_time implementation lives in project/runtime.py so the
# editor (JS) and every backend caller agree on the numbers.
from project.runtime import calc_route_noA, calc_route_runtime


def to_int(value):
    try:
        return int(value) if value != '' and value is not None else None
    except (ValueError, TypeError):
        return None


def to_float(value):
    try:
        return float(value) if value != '' and value is not None else None
    except (ValueError, TypeError):
        return None


def migrate_data(apps, schema_editor):
    OldFile = apps.get_model('coursesetter', 'publishedFile')
    File = apps.get_model('project', 'File')
    ControlPair = apps.get_model('project', 'ControlPair')
    Route = apps.get_model('project', 'Route')
    Team = apps.get_model('account', 'Team')

    for old in OldFile.objects.all():
        data = old.data or {}

        team = None
        if old.kader:
            team = Team.objects.filter(name=old.kader.name).first()

        map_file = data.get('mapFile', '')
        if map_file:
            map_file = map_file.split('/')[-1]

        file_scale = to_float(data.get('scale'))

        new_file = File.objects.create(
            name=old.filename,
            team=team,
            label=None,
            published=old.published,
            author=old.author,
            scale=file_scale,
            scaled=data.get('scaled', False),
            map_file=map_file,
            has_mask=data.get('has_mask', False),
            blocked_terrain=data.get('blockedTerrain'),
            batch_progress=old.batch_progress,
            last_edited=old.last_edited,
        )

        for cp_order, cp_data in enumerate(data.get('cP', [])):
            cp = ControlPair.objects.create(
                file=new_file,
                order=cp_order,
                ziel=cp_data.get('ziel'),
                start=cp_data.get('start'),
                complex=cp_data.get('complex', False),
            )
            for route_order, route_data in enumerate(cp_data.get('route', [])):
                rP        = route_data.get('rP') or []
                length    = to_int(route_data.get('length'))
                elevation = to_int(route_data.get('elevation'))
                # Recompute noA + run_time from the polyline using the
                # current shared algorithm so legacy data ends up on the
                # same footing as anything created by the new editor.
                new_noA      = calc_route_noA(rP, file_scale) if len(rP) >= 3 else 0
                new_run_time = calc_route_runtime(length, new_noA, elevation)

                Route.objects.create(
                    control_pair=cp,
                    order=route_order,
                    rP=rP,
                    noA=new_noA,
                    pos=to_float(route_data.get('pos')),
                    length=length,
                    run_time=new_run_time,
                    elevation=elevation,
                )


class Migration(migrations.Migration):

    dependencies = [
        ('project', '0001_initial'),
        ('coursesetter', '0011_publishedfile_batch_progress'),
        ('account', '0002_migrate_data_from_accounts'),
    ]

    operations = [
        migrations.RunPython(migrate_data, migrations.RunPython.noop),
    ]