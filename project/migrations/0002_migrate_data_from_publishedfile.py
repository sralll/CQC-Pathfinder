from django.db import migrations

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

        new_file = File.objects.create(
            name=old.filename,
            team=team,
            label=None,
            published=old.published,
            author=old.author,
            scale=to_float(data.get('scale')),
            scaled=data.get('scaled', False),
            map_file=map_file,
            has_mask=False,
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
                Route.objects.create(
                    control_pair=cp,
                    order=route_order,
                    rP=route_data.get('rP'),
                    noA=to_int(route_data.get('noA')),
                    pos=to_float(route_data.get('pos')),
                    length=to_int(route_data.get('length')),
                    run_time=to_float(route_data.get('runTime')),
                    elevation=to_int(route_data.get('elevation')),
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