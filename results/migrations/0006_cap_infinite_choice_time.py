from django.db import migrations


MAX_CHOICE_TIME = 30.0


def cap_historical_infinite_choice_times(apps, schema_editor):
    InfiniteChoice = apps.get_model('results', 'InfiniteChoice')
    InfiniteChoice.objects.filter(choice_time__gt=MAX_CHOICE_TIME).update(
        choice_time=MAX_CHOICE_TIME,
    )


class Migration(migrations.Migration):

    dependencies = [
        ('results', '0005_infinitechoice_file'),
    ]

    operations = [
        migrations.RunPython(
            cap_historical_infinite_choice_times,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
